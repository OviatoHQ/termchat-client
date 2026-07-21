/**
 * `@` mention autocomplete in the Lounge composer: `mentionPrefix` (pure) plus the
 * rendered behaviour — who it lists, what Tab does, and that an open menu is counted
 * in the layout budget instead of silently squeezing the transcript.
 */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LoungeClient, type WebSocketLike } from "../src/lounge-client.ts";
import { App, mentionPrefix } from "../src/tui/App.tsx";

class FakeSocket implements WebSocketLike {
  private handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  send(): void {}
  close(): void {}
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  deliver(message: unknown): void {
    for (const h of this.handlers.get("message") ?? []) h({ data: JSON.stringify(message) });
  }
}

const DOWN = "[B";
const ESC = "";
const TAB = "\t";
const CTRL_U = "\u0015";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
process.stdout.setMaxListeners(0);

/** Lounge with chef (self) + bob + bobby on the roster, keys live. */
function setup(messages = 0) {
  let socket: FakeSocket | undefined;
  const client = new LoungeClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    room: "general",
    token: "tok",
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  client.connect();
  socket?.deliver({
    type: "roster",
    room: "general",
    members: [
      { user: "chef", topic: null, verified: true },
      { user: "bob", topic: null, verified: true },
      { user: "bobby", topic: null, verified: true },
    ],
    guests: 0,
  });
  for (let i = 0; i < messages; i++) {
    socket?.deliver({ type: "msg", from: "bob", text: `line-${i}`, ts: i });
  }
  return render(<App client={client} user="chef" />);
}

test("mentionPrefix reads the handle being typed at the end of the draft", () => {
  expect(mentionPrefix("hi @bo")).toBe("bo");
  expect(mentionPrefix("@")).toBe(""); // a bare @ lists everyone, like a bare /
  expect(mentionPrefix("@BoB")).toBe("bob"); // matching is case-insensitive
  expect(mentionPrefix("hi @bob ")).toBeNull(); // the word is finished
  expect(mentionPrefix("hi bob")).toBeNull();
  expect(mentionPrefix("mail me at a@b")).toBeNull(); // mid-word @ is an address
  expect(mentionPrefix("/join")).toBeNull(); // that's the command menu's job
});

test("typing @ lists room members, excluding yourself", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write("@");
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("@bob");
  expect(frame).toContain("@bobby");
  expect(frame).not.toContain("@chef"); // you don't mention yourself
  expect(frame).toContain("Tab to complete · Enter sends");
});

test("the list disappears once the handle is finished", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write("hey @bobb");
  await settle();
  expect(lastFrame() ?? "").toContain("@bobby");
  stdin.write("y ");
  await settle();
  expect(lastFrame() ?? "").not.toContain("Tab to complete");
});

test("Tab completes the trailing handle and leaves the rest of the sentence alone", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write("hey @bobb");
  await settle();
  stdin.write(TAB);
  await settle();
  expect(lastFrame() ?? "").toContain("hey @bobby ");
  expect(lastFrame() ?? "").not.toContain("Tab to complete"); // completing closes it
});

test("↓ picks a different match before completing", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write("@bob");
  await settle();
  stdin.write(DOWN); // → bobby
  await settle();
  stdin.write(TAB);
  await settle();
  expect(lastFrame() ?? "").toContain("@bobby ");
});

test("Esc dismisses the menu without touching the draft; typing brings it back", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write("hey @bob");
  await settle();
  expect(lastFrame() ?? "").toContain("Tab to complete");
  stdin.write(ESC);
  await settle();
  expect(lastFrame() ?? "").not.toContain("Tab to complete");
  expect(lastFrame() ?? "").toContain("hey @bob"); // the draft survived
  stdin.write("b");
  await settle();
  expect(lastFrame() ?? "").toContain("Tab to complete"); // back on the next keystroke
});

test("an open menu is budgeted, so the transcript never silently drops rows", async () => {
  const prevRows = process.stdout.rows;
  const prevCols = process.stdout.columns;
  (process.stdout as unknown as { rows: number }).rows = 20;
  (process.stdout as unknown as { columns: number }).columns = 100;
  try {
    const { lastFrame, stdin } = setup(40);
    await settle();
    stdin.write("@b");
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(19);
    // The visible transcript must be CONSECUTIVE. Before the menu rows were counted in
    // `footerReserve`, the column overflowed and Ink dropped interior lines to fit —
    // messages disappeared mid-scrollback while a menu was open.
    const shown = [...frame.matchAll(/line-(\d+)/g)].map((m) => Number(m[1]));
    expect(shown.length).toBeGreaterThan(3);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]).toBe((shown[i - 1] as number) + 1);
    }
  } finally {
    (process.stdout as unknown as { rows: number | undefined }).rows = prevRows;
    (process.stdout as unknown as { columns: number | undefined }).columns = prevCols;
  }
});

test("Ctrl+U out of a half-typed mention hands the arrows to the roster, not the menu", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write("hey @bob");
  await settle();
  expect(lastFrame() ?? "").toContain("Tab to complete");
  stdin.write(CTRL_U); // the draft survives the focus change...
  await settle();
  // ...but the menu must not: both lists would otherwise be live, with the mention menu
  // winning ↑/↓ because its reducer branch sits above the roster's.
  expect(lastFrame() ?? "").not.toContain("Tab to complete");
  expect(lastFrame() ?? "").toContain("Roster: ↑↓ pick someone");
  stdin.write(DOWN);
  await settle();
  stdin.write("\r"); // Enter opens the highlighted member's menu — proof the roster moved
  await settle();
  expect(lastFrame() ?? "").toContain("bob: ↑↓ choose");
});
