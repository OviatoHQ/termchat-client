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
  expect(frame).toContain("#rust");
  expect(frame).toContain("alice ✓ · rust"); // verified roster entry with coarse topic
  expect(frame).toContain("3 guest(s)");
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

test("renders the tab strip with Lounge active by default", () => {
  const { client } = setup("alice");
  const { lastFrame } = render(<App client={client} user="alice" staticInput />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("[Lounge]"); // active tab is bracketed
  expect(frame).toContain("DMs"); // the DMs tab (docs/DMS.md stage 3b)
  expect(frame).toContain("Experts");
  expect(frame).toContain("Calls");
  expect(frame).toContain("Me");
});

// Pin the layout the hit-tester assumes (BODY_TOP=3): title on line 0, tab strip on
// line 1, so tab clicks at row 2 and bodies from row 3 route correctly. If someone
// inserts a header line, this fails instead of clicks silently landing a row off.
test("layout: title is line 0 and the tab strip is line 1 (anchors hit-test rows)", () => {
  const { client } = setup("alice");
  const { lastFrame } = render(<App client={client} user="alice" staticInput />);
  const lines = (lastFrame() ?? "").split("\n");
  expect(lines[0]).toContain("termchat");
  expect(lines[1]).toContain("[Lounge]");
});

test("anonymous guest shows its assigned name and a live prompt (not read-only)", () => {
  const { client, socket } = setup(null);
  socket.deliver({ type: "identity", user: "brave-otter-7k", verified: false });
  const { lastFrame } = render(<App client={client} user={null} staticInput />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("brave-otter-7k (guest"); // "(guest · /login to claim)"
  expect(frame).toContain("/login to claim");
  expect(frame).not.toContain("read-only");
});
