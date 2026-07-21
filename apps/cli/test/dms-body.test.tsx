import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { DmControllerState } from "../src/dm-controller.ts";
import { DmsBody } from "../src/tui/App.tsx";

const NOW = 1_000_000_000;
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
  const { lastFrame } = render(
    <DmsBody dm={base} sel={0} signedIn={false} dmView="inbox" now={NOW} />,
  );
  expect(lastFrame() ?? "").toContain("Sign in with /login");
});

test("inbox: '+ Send new DM' is the FIRST body row (pins DMS_INBOX_OFFSET = 0)", () => {
  const dm: DmControllerState = {
    ...base,
    threads: [{ peer: "bob", lastId: 9, lastTs: NOW - 120_000, unread: 2 }],
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn dmView="inbox" now={NOW} />);
  const firstLine = (lastFrame() ?? "").split("\n")[0] ?? "";
  expect(firstLine).toContain("Send new DM");
});

test("inbox: shows @names, relative time, and a lime unread dot; most-recent order preserved", () => {
  const dm: DmControllerState = {
    ...base,
    threads: [
      { peer: "chef-handle", displayName: "chef", lastId: 9, lastTs: NOW - 120_000, unread: 2 },
      { peer: "mira", lastId: 4, lastTs: NOW - 180_000, unread: 0 },
    ],
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn dmView="inbox" now={NOW} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("+ Send new DM");
  expect(frame).toContain("@chef"); // display name, prefixed
  expect(frame).toContain("@mira");
  expect(frame).toContain("2 mins ago");
  expect(frame).toContain("3 mins ago");
  expect(frame).toContain("●"); // the unread marker (chef has unread)
  expect(frame).not.toContain("chef-handle"); // raw handle never surfaced
});

test("inbox: selection caret sits on '+ Send new DM' at sel 0, on the first thread at sel 1", () => {
  const dm: DmControllerState = {
    ...base,
    threads: [{ peer: "bob", lastId: 9, lastTs: NOW - 60_000, unread: 0 }],
  };
  const sel0 =
    render(<DmsBody dm={dm} sel={0} signedIn dmView="inbox" now={NOW} />).lastFrame() ?? "";
  const sel1 =
    render(<DmsBody dm={dm} sel={1} signedIn dmView="inbox" now={NOW} />).lastFrame() ?? "";
  // At sel 0 the caret leads the "Send new DM" line; at sel 1 it leads the "@bob" line.
  expect(sel0.split("\n").find((l) => l.includes("Send new DM"))).toContain("›");
  expect(sel1.split("\n").find((l) => l.includes("@bob"))).toContain("›");
});

test("inbox: empty state keeps the '+ Send new DM' action", () => {
  const { lastFrame } = render(<DmsBody dm={base} sel={0} signedIn dmView="inbox" now={NOW} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("+ Send new DM");
  expect(frame).toContain("No conversations yet");
});

test("new-DM composer shows the '@username …' helper", () => {
  const { lastFrame } = render(<DmsBody dm={base} sel={0} signedIn dmView="new" now={NOW} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("New message");
  expect(frame).toContain("@username");
});

test("thread: '‹ see all DMs' is the first row, then the header + conversation", () => {
  const dm: DmControllerState = {
    ...base,
    activePeer: "bob",
    activeLabel: "bob",
    active: {
      peer: "bob",
      connected: true,
      self: "alice",
      lines: [{ id: 1, from: "bob", text: "yo bro ssup", ts: 1 }],
    },
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
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} />);
  const frame = lastFrame() ?? "";
  expect(frame.split("\n")[0] ?? "").toContain("see all DMs"); // back action first
  expect(frame).toContain("query with @bob");
  expect(frame).toContain("yo bro ssup");
  expect(frame).toContain("verify all 16 words");
  expect(frame).toContain("anchor"); // first safety word
  expect(frame).toContain("marble"); // …and the last — no truncation
});

test("thread: a long conversation is windowed to the last maxLines (input stays on-screen)", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    from: "bob",
    text: `msg-${i + 1}`,
    ts: i + 1,
  }));
  const dm: DmControllerState = {
    ...base,
    activePeer: "bob",
    activeLabel: "bob",
    active: { peer: "bob", connected: true, self: "alice", lines },
    safetyWords: [],
    keyStatus: "pinned",
  };
  const { lastFrame } = render(
    <DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} maxLines={5} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("msg-20"); // newest shown
  expect(frame).toContain("msg-16"); // last 5 → msg-16..20
  expect(frame).not.toContain("msg-15"); // older ones windowed out
  expect(frame).not.toContain("msg-1 "); // (trailing space guards against msg-1x match)
});

test("thread: a changed key raises a loud warning", () => {
  const dm: DmControllerState = {
    ...base,
    activePeer: "bob",
    activeLabel: "bob",
    keyStatus: "changed",
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} />);
  expect(lastFrame() ?? "").toContain("safety number changed");
});

test("thread: a peer with no key shows the friendly error", () => {
  const dm: DmControllerState = {
    ...base,
    activePeer: "ghost",
    activeLabel: "ghost",
    error: "@ghost hasn't published a DM key on this server yet.",
  };
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} />);
  expect(lastFrame() ?? "").toContain("hasn't published a DM key");
});

test("thread: display names label messages; the raw handle is never surfaced", () => {
  const dm: DmControllerState = {
    ...base,
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
  const { lastFrame } = render(<DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("query with @chef"); // header uses the display name
  expect(frame).toContain("<chef> hey there"); // peer message labelled by display name
  expect(frame).toContain("<me> yo"); // my own message stays "me"
  expect(frame).not.toContain("shafiu"); // the raw handle is never surfaced
});

test("thread: an offset scrolls the transcript up and flags newer messages below", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    from: "bob",
    text: `msg-${i + 1}`,
    ts: i + 1,
  }));
  const dm: DmControllerState = {
    ...base,
    activePeer: "bob",
    activeLabel: "bob",
    active: { peer: "bob", connected: true, self: "alice", lines },
    safetyWords: [],
    keyStatus: "pinned",
  };
  // maxLines 5, scrolled up 3 rows → the bottom-of-window is msg-17, msgs 18..20 hidden.
  const { lastFrame } = render(
    <DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} maxLines={5} offset={3} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("msg-13"); // window is msg-13..17
  expect(frame).toContain("msg-17");
  expect(frame).not.toContain("msg-18"); // newer, below the fold
  expect(frame).toContain("▾ 3 newer"); // the scrolled-up hint
});

test("inbox: a long inbox windows to follow the selection", () => {
  const threads = Array.from({ length: 15 }, (_, i) => ({
    peer: `peer${String(i).padStart(2, "0")}`,
    lastId: i,
    lastTs: NOW - i * 1000,
    unread: 0,
  }));
  const dm: DmControllerState = { ...base, threads };
  // Rows: index 0 = new-DM, index i≥1 = threads[i-1]. Window start 8, count 4, sel 9.
  const { lastFrame } = render(
    <DmsBody dm={dm} sel={9} signedIn dmView="inbox" now={NOW} start={8} count={4} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("Send new DM"); // row 0 is above the fold now
  expect(frame).toContain("@peer08"); // thread index 9 → threads[8]
  expect(frame.split("\n").find((l) => l.includes("@peer08"))).toContain("›"); // selected
});

test("thread: a scrolled thread with a full 16-word safety number stays within budget", () => {
  // Regression: the "▾ N newer" hint must be reserved from the window height, not added
  // on top — a wrapping 16-word safety line already makes the header 2 rows at 80 cols,
  // so an un-reserved hint would push the body one row over and flicker the input line.
  const lines = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    from: "bob",
    text: `msg-${i + 1}`,
    ts: i + 1,
  }));
  const words = [
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
  ];
  const dm: DmControllerState = {
    ...base,
    activePeer: "bob",
    activeLabel: "bob",
    active: { peer: "bob", connected: true, self: "alice", lines },
    safetyWords: words,
    keyStatus: "pinned",
  };
  // The App passes maxLines already reduced by one when scrolled (offset>0); mirror that:
  // an un-scrolled thread fits `maxLines` message rows, a scrolled one fits `maxLines - 1`
  // plus the hint — so both render the SAME number of body rows.
  const MAX = 8;
  const pinned =
    render(
      <DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} maxLines={MAX} offset={0} />,
    ).lastFrame() ?? "";
  const scrolled =
    render(
      <DmsBody dm={dm} sel={0} signedIn dmView="thread" now={NOW} maxLines={MAX - 1} offset={4} />,
    ).lastFrame() ?? "";
  // A scrolled thread must not be taller than the pinned one (the reserved-row invariant).
  expect(scrolled.split("\n").length).toBeLessThanOrEqual(pinned.split("\n").length);
  expect(scrolled).toContain("▾ 4 newer"); // the hint is present…
  expect(scrolled).toContain("marble"); // …and the full safety number still renders
});
