import { expect, test } from "bun:test";
import type { BountyCard, ExpertCard, SessionCard } from "@termchat/protocol";
import { render } from "ink-testing-library";
import { BountiesBody, CallsBody, ExpertsBody, MeBody } from "../src/tui/App.tsx";
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
  expect(lines[0]).toContain("Experts"); // header on line 0
  expect(lines[EXPERTS_LIST_OFFSET]).toContain("zzmarker");
});

test("layout: first Me action sits at ME_LIST_OFFSET below the body top", () => {
  const lines = (
    render(
      <MeBody actions={[{ label: "zzmarker-action" }]} sel={0} user="alice" self="alice" />,
    ).lastFrame() ?? ""
  ).split("\n");
  expect(lines[0]).toContain("Me"); // header on line 0
  expect(lines[ME_LIST_OFFSET]).toContain("zzmarker-action");
});

test("ExpertsBody: online expert renders dot, topics, rate, rating, and a Summon CTA", () => {
  const { lastFrame } = render(<ExpertsBody experts={[card({})]} sel={0} signedIn />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("●"); // online dot
  expect(frame).toContain("dana");
  expect(frame).toContain("rust, wasm");
  expect(frame).toContain("$2/min");
  expect(frame).toContain("★4.9 (37)");
  expect(frame).toContain("[ Summon ]");
  expect(frame).toContain("›"); // selected-row marker
});

test("ExpertsBody: offline expert gets a hollow dot and a Bounty CTA", () => {
  const { lastFrame } = render(
    <ExpertsBody experts={[card({ user: "farah", online: false })]} sel={0} signedIn />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("○"); // offline dot
  expect(frame).toContain("[ Bounty ]");
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

test("ExpertsBody: signed-out shows a sign-in prompt, not the list", () => {
  const { lastFrame } = render(<ExpertsBody experts={[card({})]} sel={0} signedIn={false} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Sign in");
  expect(frame).not.toContain("[ Summon ]");
});

test("ExpertsBody: empty list shows a quiet placeholder", () => {
  const { lastFrame } = render(<ExpertsBody experts={[]} sel={0} signedIn />);
  expect(lastFrame() ?? "").toContain("No experts listed");
});

test("layout: first bounty row sits at BOUNTIES_LIST_OFFSET below the body top", () => {
  const lines = (
    render(<BountiesBody bounties={[bounty({ bountyId: 77 })]} sel={0} signedIn />).lastFrame() ??
    ""
  ).split("\n");
  expect(lines[0]).toContain("Bounties"); // header on line 0
  expect(lines[BOUNTIES_LIST_OFFSET]).toContain("#77");
});

test("BountiesBody: open bounty shows id, price, topic, question, and a Claim CTA", () => {
  const frame = render(<BountiesBody bounties={[bounty({})]} sel={0} signedIn />).lastFrame() ?? "";
  expect(frame).toContain("#14");
  expect(frame).toContain("$3.00");
  expect(frame).toContain("rust");
  expect(frame).toContain("borrow checker");
  expect(frame).toContain("[ Claim ]");
  expect(frame).toContain("[ Post a bounty ]"); // the post action always follows
});

test("BountiesBody: empty board still offers Post; signed-out shows a prompt", () => {
  const empty = render(<BountiesBody bounties={[]} sel={0} signedIn />).lastFrame() ?? "";
  expect(empty).toContain("No open bounties");
  expect(empty).toContain("[ Post a bounty ]");
  const guest =
    render(<BountiesBody bounties={[bounty({})]} sel={0} signedIn={false} />).lastFrame() ?? "";
  expect(guest).toContain("Sign in");
  expect(guest).not.toContain("[ Claim ]");
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
  ).toContain("No active call");
  expect(
    render(<CallsBody active={7} sessions={[]} sel={0} signedIn />).lastFrame() ?? "",
  ).toContain("Active: session #7");
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
  expect(lines[0]).toContain("Calls"); // header on line 0
  expect(lines[CALLS_LIST_OFFSET]).toContain("#77");
});

test("MeBody: guest lists Log in; signed-in header shows the handle", () => {
  const guest = render(
    <MeBody actions={[{ label: "Log in with GitHub" }]} sel={0} user={null} self="brave-otter" />,
  );
  expect(guest.lastFrame() ?? "").toContain("Log in with GitHub");
  expect(guest.lastFrame() ?? "").toContain("Guest: brave-otter");

  const signedIn = render(
    <MeBody actions={[{ label: "Log out" }]} sel={0} user="alice" self="alice" />,
  );
  expect(signedIn.lastFrame() ?? "").toContain("Signed in as alice ✓");
});
