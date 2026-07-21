import { expect, test } from "bun:test";
import type { BountyCard, ExpertCard, SessionCard } from "@termchat/protocol";
import { render } from "ink-testing-library";
import {
  BountiesBody,
  CallsBody,
  ExpertsBody,
  MeBody,
  SummonConfirmBody,
} from "../src/tui/App.tsx";
import {
  BOUNTIES_LIST_OFFSET,
  CALLS_LIST_OFFSET,
  EXPERTS_LIST_OFFSET,
  ME_LIST_OFFSET,
} from "../src/tui/hit-test.ts";

const bounty = (over: Partial<BountyCard>): BountyCard => ({
  bountyId: 14,
  seeker: "ben",
  topic: "rust",
  question: "why won't the borrow checker let me?",
  priceCents: 300,
  createdAt: 0,
  ...over,
});

const card = (over: Partial<ExpertCard>): ExpertCard => ({
  user: "dana",
  rate: 2,
  topics: ["rust", "wasm"],
  rating: 4.9,
  ratingCount: 37,
  sessions: 40,
  reputationTier: "gold",
  topExpert: false,
  online: true,
  ...over,
});

// Pin the within-body row offsets the hit-tester uses: the first expert/action must
// land exactly EXPERTS_LIST_OFFSET / ME_LIST_OFFSET lines below the body top, or
// clicks route to the wrong row. Anchors the otherwise-circular hit-test constants.
test("layout: first expert row sits at EXPERTS_LIST_OFFSET below the body top", () => {
  const lines = (
    render(<ExpertsBody experts={[card({ user: "zzmarker" })]} sel={0} signedIn />).lastFrame() ??
    ""
  ).split("\n");
  expect(lines[0]).toContain("EXPERTS"); // header on line 0
  expect(lines[EXPERTS_LIST_OFFSET]).toContain("zzmarker");
});

test("layout: first Me action sits at ME_LIST_OFFSET below the body top", () => {
  const lines = (
    render(
      <MeBody actions={[{ label: "zzmarker-action" }]} sel={0} user="alice" self="alice" />,
    ).lastFrame() ?? ""
  ).split("\n");
  expect(lines[0]).toContain("ME"); // header on line 0
  expect(lines[ME_LIST_OFFSET]).toContain("zzmarker-action");
});

test("ExpertsBody: online expert renders dot, topics, rate, rating, and a Call CTA", () => {
  const { lastFrame } = render(<ExpertsBody experts={[card({})]} sel={0} signedIn />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("●"); // online dot
  expect(frame).toContain("dana");
  expect(frame).toContain("rust wasm");
  expect(frame).toContain("$2/min");
  expect(frame).toContain("★4.9 (37)");
  expect(frame).toContain("call"); // lime call chip
  expect(frame).toContain("›"); // selected-row marker
});

test("ExpertsBody: offline expert gets a hollow dot and a Bounty CTA", () => {
  const { lastFrame } = render(
    <ExpertsBody experts={[card({ user: "farah", online: false })]} sel={0} signedIn />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("○"); // offline dot
  expect(frame).toContain("[bounty]");
});

test("ExpertsBody: unrated expert shows '★ new'; topExpert shows the star badge", () => {
  const { lastFrame } = render(
    <ExpertsBody
      experts={[card({ rating: null, ratingCount: 0, topExpert: true })]}
      sel={0}
      signedIn
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("★ new");
  expect(frame).toContain("⭐");
});

test("SummonConfirmBody: spells out the hold (rate × 30-min cap) + the typed problem", () => {
  const frame =
    render(
      <SummonConfirmBody
        expert={card({ user: "dana", rate: 2, topExpert: true })}
        problem="borrow checker fight"
        cursorOn={true}
      />,
    ).lastFrame() ?? "";
  expect(frame).toContain("CALL DANA"); // confirm header
  expect(frame).toContain("$2/min"); // the rate (amber)
  expect(frame).toContain("$60.00 max"); // hold = rate × 30-min cap
  expect(frame).toContain("borrow checker fight"); // the problem input echoes the draft
  expect(frame).toContain("authorize $60.00 hold");
  expect(frame).toContain("[cancel]");
});

test("ExpertsBody: signed-out shows a sign-in prompt, not the list", () => {
  const { lastFrame } = render(<ExpertsBody experts={[card({})]} sel={0} signedIn={false} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Sign in");
  expect(frame).not.toContain("$2/min"); // the expert rows aren't rendered
});

test("ExpertsBody: empty list shows a quiet placeholder", () => {
  const { lastFrame } = render(<ExpertsBody experts={[]} sel={0} signedIn />);
  expect(lastFrame() ?? "").toContain("No experts listed");
});

test("layout: first bounty row sits at BOUNTIES_LIST_OFFSET below the body top", () => {
  const lines = (
    render(
      <BountiesBody bounties={[bounty({ bountyId: 77 })]} sel={0} signedIn now={0} />,
    ).lastFrame() ?? ""
  ).split("\n");
  expect(lines[0]).toContain("BOUNTIES"); // header on line 0
  expect(lines[BOUNTIES_LIST_OFFSET]).toContain("#77");
});

test("BountiesBody: open bounty shows id, price, topic, question, age, and a Claim CTA", () => {
  // createdAt 0, now = 2h → "open 2h" (the age column from the mock).
  const frame =
    render(
      <BountiesBody bounties={[bounty({})]} sel={0} signedIn now={2 * 3_600_000} />,
    ).lastFrame() ?? "";
  expect(frame).toContain("#14");
  expect(frame).toContain("$3.00");
  expect(frame).toContain("rust");
  expect(frame).toContain("borrow checker");
  expect(frame).toContain("open 2h"); // relative age since posting
  expect(frame).toContain("[claim]");
  expect(frame).toContain("[post a bounty]"); // the post action always follows
});

test("BountiesBody: empty board still offers Post; signed-out shows a prompt", () => {
  const empty = render(<BountiesBody bounties={[]} sel={0} signedIn now={0} />).lastFrame() ?? "";
  expect(empty).toContain("No open bounties");
  expect(empty).toContain("[post a bounty]");
  const guest =
    render(<BountiesBody bounties={[bounty({})]} sel={0} signedIn={false} now={0} />).lastFrame() ??
    "";
  expect(guest).toContain("Sign in");
  expect(guest).not.toContain("[claim]");
});

const sessionCard = (over: Partial<SessionCard>): SessionCard => ({
  sessionId: 12,
  role: "seeker",
  peer: "dana",
  topic: "rust",
  status: "ended",
  minutes: 8,
  amountCents: 1600,
  endedAt: 1,
  reviewed: false,
  reviewable: true,
  ...over,
});

test("CallsBody: active-session line reflects state; signed-out shows a prompt", () => {
  expect(
    render(<CallsBody active={null} sessions={[]} sel={0} signedIn />).lastFrame() ?? "",
  ).toContain("no active call");
  expect(
    render(<CallsBody active={7} sessions={[]} sel={0} signedIn />).lastFrame() ?? "",
  ).toContain("session #7 live");
  expect(
    render(<CallsBody active={null} sessions={[]} sel={0} signedIn={false} />).lastFrame() ?? "",
  ).toContain("Sign in");
});

test("CallsBody: reviewable session shows a rate tag; reviewed + expert-role differ", () => {
  const frame =
    render(
      <CallsBody
        active={null}
        sel={0}
        signedIn
        sessions={[
          sessionCard({ sessionId: 12, peer: "dana", reviewable: true }),
          sessionCard({ sessionId: 9, peer: "erik", reviewed: true, reviewable: false }),
          sessionCard({ sessionId: 5, peer: "gita", role: "expert", reviewable: false }),
        ]}
      />,
    ).lastFrame() ?? "";
  expect(frame).toContain("#12 dana");
  expect(frame).toContain("★ rate");
  expect(frame).toContain("✓ reviewed");
  expect(frame).toContain("you were the expert");
});

test("layout: first Calls session row sits at CALLS_LIST_OFFSET below the body top", () => {
  const lines = (
    render(
      <CallsBody active={null} sel={0} signedIn sessions={[sessionCard({ sessionId: 77 })]} />,
    ).lastFrame() ?? ""
  ).split("\n");
  expect(lines[0]).toContain("CALLS"); // header on line 0
  expect(lines[CALLS_LIST_OFFSET]).toContain("#77");
});

test("MeBody: guest lists Log in; signed-in header shows the handle", () => {
  const guest = render(
    <MeBody actions={[{ label: "Log in with GitHub" }]} sel={0} user={null} self="brave-otter" />,
  );
  expect(guest.lastFrame() ?? "").toContain("Log in with GitHub");
  expect(guest.lastFrame() ?? "").toContain("guest: brave-otter");

  const signedIn = render(
    <MeBody actions={[{ label: "Log out" }]} sel={0} user="alice" self="alice" />,
  );
  expect(signedIn.lastFrame() ?? "").toContain("alice ✓");
});

test("windowed list: only the on-screen slice renders, with an '↑/↓ more' hint", () => {
  const experts = Array.from({ length: 12 }, (_, i) =>
    card({ user: `exp${String(i).padStart(2, "0")}`, online: true }),
  );
  // Window rows 4..7 (start 4, count 4) with the selection inside it.
  const frame =
    render(<ExpertsBody experts={experts} sel={5} signedIn start={4} count={4} />).lastFrame() ??
    "";
  expect(frame).toContain("exp04"); // first windowed row
  expect(frame).toContain("exp07"); // last windowed row
  expect(frame).not.toContain("exp03"); // above the fold
  expect(frame).not.toContain("exp08"); // below the fold
  // The caret marks the true selection (index 5), not the first drawn row.
  expect(frame.split("\n").find((l) => l.includes("exp05"))).toContain("›");
  // Both overflow directions are advertised (4 above, 4 below).
  expect(frame).toContain("↑ 4 more");
  expect(frame).toContain("↓ 4 more");
});
