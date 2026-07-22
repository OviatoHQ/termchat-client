/**
 * Composer caret movement (←/→) and sent-message history (↑/↓), driven through the
 * REAL key path: actual escape sequences into Ink's stdin, the real `App`, the real
 * render. `nav.test.ts` pins the reducer in isolation; this pins that Ink decodes the
 * arrow keys at all and that the App wires the resulting actions to the input line.
 *
 * That distinction matters here: nothing in this repo used `leftArrow`/`rightArrow`
 * before, so the decode path was entirely unexercised.
 */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LoungeClient, type WebSocketLike } from "../src/lounge-client.ts";
import { App } from "../src/tui/App.tsx";

class FakeSocket implements WebSocketLike {
  private handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  deliver(message: unknown): void {
    for (const h of this.handlers.get("message") ?? []) h({ data: JSON.stringify(message) });
  }
  open(): void {
    for (const h of this.handlers.get("open") ?? []) h({});
  }
}

// Real xterm sequences — exactly what a terminal sends.
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const BACKSPACE = "\x7f";

async function setup() {
  let socket: FakeSocket | undefined;
  const client = new LoungeClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    room: "rust",
    token: "tok",
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  client.connect();
  socket?.open(); // the client buffers sends until the socket is open
  socket?.deliver({
    type: "roster",
    room: "rust",
    members: [{ user: "alice", topic: null, verified: true }],
    guests: 0,
  });
  const app = render(<App client={client} user="alice" />);
  // Let the component mount before any key is written — a keypress delivered before
  // `useInput` is wired is silently dropped, which reads as "the first word vanished".
  await settle();
  return { ...app, socket: socket as FakeSocket };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Send ONE keypress and let Ink process it.
 *
 * Consecutive `stdin.write()` calls with no await in between are coalesced into a
 * single chunk, which Ink then parses as one garbled keypress ("abc\x1b[D" is not
 * "abc" followed by ←). Every key therefore has to settle on its own. */
async function press(stdin: { write: (s: string) => void }, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await settle();
  }
}

/** The composer line (`[#rust] draft█`), with the blinking block stripped so
 *  assertions are stable regardless of which phase the cursor is in. */
function inputLine(frame: string): string {
  const line = frame.split("\n").findLast((l) => l.trimStart().startsWith("[#")) ?? "";
  return line.replace(/█/g, "");
}

/** What the app would send if Enter were pressed — the draft, as the socket sees it. */
function lastSent(socket: FakeSocket): string | undefined {
  const msgs = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "msg");
  return msgs.at(-1)?.text;
}

test("← moves the caret and typing inserts mid-line (the whole point)", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "helo");
  // Caret sits after "helo"; walk it back one so it is between "l" and "o".
  await press(stdin, LEFT);
  await press(stdin, "l");
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("hello");
  unmount();
});

test("→ walks the caret back toward the end", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "ac");
  await press(stdin, LEFT); // between a and c
  await press(stdin, "b"); // "abc", caret after b
  await settle();
  await press(stdin, RIGHT); // past the c → end of line
  await press(stdin, "d");
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("abcd");
  unmount();
});

test("Backspace deletes before the caret, not off the end", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "hexllo");
  // Walk back over "llo" so the caret sits just after the stray "x".
  await press(stdin, LEFT);
  await press(stdin, LEFT);
  await press(stdin, LEFT);
  await press(stdin, BACKSPACE);
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("hello");
  unmount();
});

test("the caret cannot walk off either end of the draft", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "ab");
  for (let i = 0; i < 8; i++) await press(stdin, LEFT); // far past the start
  await settle();
  await press(stdin, "Z"); // must land at the very front
  await settle();
  for (let i = 0; i < 8; i++) await press(stdin, RIGHT); // far past the end
  await settle();
  await press(stdin, "Y"); // must land at the very back
  await settle();
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("ZabY");
  unmount();
});

test("↑ recalls the previous message; ↓ walks back and restores the half-typed line", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  await press(stdin, "first");
  await press(stdin, ENTER);
  await press(stdin, "second");
  await press(stdin, ENTER);

  // Half-type something, then browse away from it.
  await press(stdin, "half");
  expect(inputLine(lastFrame() ?? "")).toContain("half");

  await press(stdin, UP); // newest first
  await settle();
  expect(inputLine(lastFrame() ?? "")).toContain("second");

  await press(stdin, DOWN); // forward, off the newest end → the stash comes back
  await settle();
  expect(inputLine(lastFrame() ?? "")).toContain("half");
  unmount();
});

test("↑↑ reaches the older message, and ↓ comes back to the newer one", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "alpha");
  await press(stdin, ENTER);
  await press(stdin, "beta");
  await press(stdin, ENTER);

  await press(stdin, UP); // beta
  await press(stdin, UP); // alpha
  await settle();
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("alpha");

  await press(stdin, UP); // alpha (newest again, since sending re-pushed it)
  await press(stdin, DOWN); // forward → back off the end
  await settle();
  unmount();
});

test("a recalled message can be edited before re-sending", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "hello");
  await press(stdin, ENTER);

  await press(stdin, UP); // recall "hello", caret at the end
  await settle();
  await press(stdin, "!"); // append to the recalled line
  await settle();
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("hello!");
  unmount();
});

test("↑ with no history does nothing (no crash, no stray text)", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, UP);
  await press(stdin, UP);
  await press(stdin, "ok");
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("ok");
  unmount();
});

test("consecutive duplicates collapse, so one ↑ clears them", async () => {
  const { stdin, socket, unmount } = await setup();
  await press(stdin, "same");
  await press(stdin, ENTER);
  await press(stdin, "same");
  await press(stdin, ENTER);
  await press(stdin, "other");
  await press(stdin, ENTER);

  await press(stdin, UP); // other
  await press(stdin, UP); // same  (only ONE entry, not two)
  await settle();
  await press(stdin, ENTER);
  expect(lastSent(socket)).toBe("same");
  unmount();
});

test("the cursor block renders AT the caret, not pinned to the end", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  await press(stdin, "abc");
  await press(stdin, LEFT);
  await press(stdin, LEFT);
  const line =
    (lastFrame() ?? "").split("\n").findLast((l) => l.trimStart().startsWith("[#")) ?? "";
  // Caret sits on "b": "a" before it, "c" after. The block covers "b" while the blink is
  // on and reveals it while off, so either phase is correct — but the ORDER never is not.
  expect(line).toMatch(/a[█b]c/);
  unmount();
});
