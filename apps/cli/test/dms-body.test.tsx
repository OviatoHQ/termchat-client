import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { DmControllerState } from "../src/dm-controller.ts";
import { DmsBody } from "../src/tui/App.tsx";

const base: DmControllerState = {
  threads: [],
  activePeer: null,
  activeLabel: null,
  active: null,
  safetyWords: [],
  keyStatus: null,
  error: null,
};

test("guests are prompted to sign in (DMs are login-only)", () => {
  const { lastFrame } = render(<DmsBody dm={base} sel={0} signedIn={false} sidebarWidth={20} />);
  expect(lastFrame() ?? "").toContain("Sign in with /login");
});

test("renders the thread list with unread badges", () => {
  const dm: DmControllerState = {
    ...base,
    threads: [
      { peer: "bob", lastId: 9, lastTs: 100, unread: 2 },
      { peer: "carol", lastId: 4, lastTs: 90, unread: 0 },
    ],
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn sidebarWidth={20} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("bob");
  expect(frame).toContain("●2"); // unread badge
  expect(frame).toContain("carol");
  expect(frame).toContain("Select a thread"); // no thread open yet
});

test("an open thread shows the conversation and the safety-number header", () => {
  const dm: DmControllerState = {
    ...base,
    threads: [{ peer: "bob", lastId: 1, lastTs: 1, unread: 0 }],
    activePeer: "bob",
    active: {
      peer: "bob",
      connected: true,
      self: "alice",
      lines: [{ id: 1, from: "bob", text: "yo bro ssup", ts: 1 }],
    },
    // A full 16-word (128-bit) safety number — the header must show ALL of them.
    safetyWords: [
      "anchor",
      "ribbon",
      "maple",
      "velvet",
      "cedar",
      "harbor",
      "quartz",
      "willow",
      "copper",
      "meadow",
      "falcon",
      "pebble",
      "cobalt",
      "juniper",
      "lantern",
      "marble",
    ],
    keyStatus: "new",
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn sidebarWidth={20} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("query with bob");
  expect(frame).toContain("yo bro ssup");
  expect(frame).toContain("verify all 16 words");
  expect(frame).toContain("anchor"); // first word
  expect(frame).toContain("marble"); // …and the last — no truncation
});

test("a changed key raises a loud warning", () => {
  const dm: DmControllerState = { ...base, activePeer: "bob", keyStatus: "changed" };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn sidebarWidth={20} />);
  expect(lastFrame() ?? "").toContain("safety number changed");
});

test("opening a peer with no key shows the friendly error", () => {
  const dm: DmControllerState = {
    ...base,
    activePeer: "ghost",
    error: "ghost hasn't set up DMs yet.",
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn sidebarWidth={20} />);
  expect(lastFrame() ?? "").toContain("hasn't set up DMs");
});

test("shows display names (nick) as labels while keying by the stable handle", () => {
  const dm: DmControllerState = {
    ...base,
    threads: [{ peer: "shafiu", displayName: "chef", lastId: 3, lastTs: 5, unread: 1 }],
    activePeer: "shafiu",
    activeLabel: "chef",
    active: {
      peer: "shafiu",
      connected: true,
      self: "alice",
      lines: [
        { id: 1, from: "shafiu", text: "hey there", ts: 1 },
        { id: 2, from: "alice", text: "yo", ts: 2 },
      ],
    },
    safetyWords: [],
    keyStatus: "pinned",
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn sidebarWidth={20} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("query with chef"); // header uses the display name
  expect(frame).toContain("<chef> hey there"); // peer message labelled by display name
  expect(frame).toContain("<me> yo"); // my own message stays "me"
  expect(frame).not.toContain("shafiu"); // the raw handle is never surfaced
});
