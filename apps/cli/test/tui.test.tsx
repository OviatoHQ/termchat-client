import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LoungeClient, type WebSocketLike } from "../src/lounge-client.ts";
import { App } from "../src/tui/App.tsx";

class FakeSocket implements WebSocketLike {
  private handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  send(): void {}
  close(): void {}
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  fire(type: string, event: { data?: unknown } = {}): void {
    for (const h of this.handlers.get(type) ?? []) h(event);
  }
  deliver(message: unknown): void {
    this.fire("message", { data: JSON.stringify(message) });
  }
}

function setup(user: string | null) {
  let socket: FakeSocket | undefined;
  const client = new LoungeClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    room: "rust",
    ...(user ? { token: "tok" } : {}),
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  client.connect();
  return { client, socket: socket as FakeSocket };
}

test("renders the lounge chrome, roster, and messages (App seeds from client state)", () => {
  const { client, socket } = setup("alice");
  // State delivered before mount is shown via the App's initial getState().
  socket.deliver({
    type: "roster",
    room: "rust",
    members: [{ user: "alice", topic: "rust", verified: true }],
    guests: 3,
  });
  socket.deliver({ type: "msg", from: "bob", text: "hey alice", ts: 1 });

  const { lastFrame } = render(<App client={client} user="alice" staticInput />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("termchat");
  expect(frame).toContain("#RUST"); // roster header for the current room
  expect(frame).toContain("alice ✓ rust"); // verified roster entry with coarse topic
  expect(frame).toContain("4 online"); // 1 member + 3 guests in the olive top bar
  expect(frame).toContain("bob");
  expect(frame).toContain("hey alice");
});

test("re-renders reactively when a new message arrives after mount", async () => {
  const { client, socket } = setup("alice");
  const { lastFrame } = render(<App client={client} user="alice" staticInput />);
  await new Promise((r) => setTimeout(r, 0)); // let the subscribe effect flush
  socket.deliver({ type: "msg", from: "carol", text: "ping", ts: 2 });
  await new Promise((r) => setTimeout(r, 0));
  expect(lastFrame() ?? "").toContain("ping");
});

test("renders the numbered window strip with lounge active by default", () => {
  const { client } = setup("alice");
  const { lastFrame } = render(<App client={client} user="alice" staticInput />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("[1:lounge]"); // active window is bracketed
  expect(frame).toContain("2:dms"); // the DMs window (docs/DMS.md stage 3b)
  expect(frame).toContain("3:experts");
  expect(frame).toContain("5:calls");
  expect(frame).toContain("6:me");
});

// Pin the layout the hit-tester assumes (BODY_TOP=3): the top bar on line 0, the window
// strip on line 1, so window clicks at row 2 and bodies from row 3 route correctly. If
// someone inserts a header line, this fails instead of clicks silently landing a row off.
test("layout: top bar is line 0 and the window strip is line 1 (anchors hit-test rows)", () => {
  const { client } = setup("alice");
  const { lastFrame } = render(<App client={client} user="alice" staticInput />);
  const lines = (lastFrame() ?? "").split("\n");
  expect(lines[0]).toContain("termchat");
  expect(lines[1]).toContain("[1:lounge]");
});

test("anonymous guest shows its assigned name and a live prompt (not read-only)", () => {
  const { client, socket } = setup(null);
  socket.deliver({ type: "identity", user: "brave-otter-7k", verified: false });
  const { lastFrame } = render(<App client={client} user={null} staticInput />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("brave-otter-7k"); // its assigned guest name, on the notice row
  expect(frame).toContain("[#rust]"); // a live lime input prompt (guests can chat)
  expect(frame).not.toContain("read-only");
});

test("lounge tail-windows a long transcript and caps the roster with '+N more'", () => {
  const { client, socket } = setup("alice");
  // A crowd bigger than the sidebar can show, and far more messages than fit.
  const members = Array.from({ length: 40 }, (_, i) => ({
    user: `m${String(i).padStart(2, "0")}`,
    topic: null,
    verified: false,
  }));
  socket.deliver({ type: "roster", room: "rust", members, guests: 0 });
  for (let i = 0; i < 80; i++) {
    socket.deliver({ type: "msg", from: "bob", text: `line-${String(i).padStart(2, "0")}`, ts: i });
  }
  const frame = render(<App client={client} user="alice" staticInput />).lastFrame() ?? "";
  // Newest line is on screen; a line from early in the (windowed-out) history is not.
  expect(frame).toContain("line-79");
  expect(frame).not.toContain("line-00");
  // The roster is windowed to what fits and advertises the overflow (never clips silently).
  expect(frame).toMatch(/\+\d+ more/);
});

test("wrapping messages never overflow the box, and the newest hugs the divider", () => {
  const prevCols = process.stdout.columns;
  const prevRows = process.stdout.rows;
  (process.stdout as unknown as { columns: number }).columns = 90;
  (process.stdout as unknown as { rows: number }).rows = 20;
  try {
    const { client, socket } = setup("chef");
    socket.deliver({
      type: "roster",
      room: "rust",
      members: [{ user: "chef", topic: null, verified: true }],
      guests: 0,
    });
    // Messages long enough to wrap to 3+ rows each — the case that used to overflow.
    const long =
      "It ships with 32 extra interchangeable keycaps, connects via Bluetooth or USB-C and is compatible with Mac and Windows and everything else you could want here";
    for (let i = 0; i < 12; i++) {
      socket.deliver({ type: "msg", from: "chef", text: i % 2 ? long : `short-${i}`, ts: i });
    }
    const frame = render(<App client={client} user="chef" staticInput />).lastFrame() ?? "";
    const lines = frame.split("\n");
    // Never taller than the box (rows - 1) — the overflow that corrupted the redraw.
    expect(lines.length).toBeLessThanOrEqual(19);
    // The horizontal rule divides transcript from the notice/input.
    const ruleIdx = lines.findIndex((l) => /────────/.test(l));
    expect(ruleIdx).toBeGreaterThan(0);
    // Newest content sits on the row directly above the rule — no blank gap there.
    expect((lines[ruleIdx - 1] ?? "").trim().length).toBeGreaterThan(0);
  } finally {
    (process.stdout as unknown as { columns: number | undefined }).columns = prevCols;
    (process.stdout as unknown as { rows: number | undefined }).rows = prevRows;
  }
});
