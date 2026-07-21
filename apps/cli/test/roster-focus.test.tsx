/**
 * Lounge roster focus (Ctrl+U) and the member action menu, driven through the real
 * key path — `reduceKey` is unit-tested in nav.test.ts, this pins that the App wires
 * those actions to the render (highlight, menu items, and the way out).
 */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LoungeClient, type WebSocketLike } from "../src/lounge-client.ts";
import { MarketplaceClient } from "../src/marketplace-client.ts";
import { App } from "../src/tui/App.tsx";
import { BODY_TOP, ROSTER_LIST_OFFSET } from "../src/tui/hit-test.ts";

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

const CTRL_U = "";
const DOWN = "[B";
const ENTER = "\r";
const ESC = "";

/** Render the Lounge with `alice` (self) + `bob` on the roster, keys enabled. */
function setup() {
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
  socket?.deliver({
    type: "roster",
    room: "rust",
    members: [
      { user: "alice", topic: null, verified: true },
      { user: "bob", topic: "rust", verified: true },
    ],
    guests: 0,
  });
  const app = render(<App client={client} user="alice" />);
  return app;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

// Each render subscribes a resize listener to the shared stdout; this file mounts the App
// once per test, which trips Node's default max-listeners warning. Not a leak in the app.
process.stdout.setMaxListeners(0);

test("Ctrl+U moves the keyboard from the composer to the roster (and says so)", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  expect(lastFrame() ?? "").toContain("type to chat"); // the idle hint
  stdin.write(CTRL_U);
  await settle();
  expect(lastFrame() ?? "").toContain("Roster: ↑↓ pick someone");
});

test("roster focus: printable keys don't reach the chat draft", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write(CTRL_U);
  await settle();
  stdin.write("hello");
  await settle();
  // The input line still shows the bare prompt — "hello" went nowhere.
  expect(lastFrame() ?? "").not.toContain("hello");
});

test("Enter opens the selected member's action menu (self row has no Send DM)", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write(CTRL_U); // lands on row 0 = alice, who is us
  await settle();
  stdin.write(ENTER);
  await settle();
  const own = lastFrame() ?? "";
  expect(own).toContain("Tag in #rust");
  expect(own).not.toContain("Send DM"); // you can't DM yourself
});

test("↓ then Enter opens bob's menu, with DM + tag and no call (he isn't an expert)", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write(CTRL_U);
  await settle();
  stdin.write(DOWN);
  await settle();
  stdin.write(ENTER);
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Send DM");
  expect(frame).toContain("Tag in #rust");
  expect(frame).not.toContain("Call $"); // the marketplace doesn't list bob
  expect(frame).toContain("bob: ↑↓ choose"); // the menu's own hint names the person
});

test("Esc unwinds one level at a time: menu → roster → composer", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write(CTRL_U);
  await settle();
  stdin.write(ENTER);
  await settle();
  expect(lastFrame() ?? "").toContain("Tag in #rust");
  stdin.write(ESC); // close the menu, stay on the roster
  await settle();
  expect(lastFrame() ?? "").not.toContain("Tag in #rust");
  expect(lastFrame() ?? "").toContain("Roster: ↑↓ pick someone");
  stdin.write(ESC); // back to the composer
  await settle();
  expect(lastFrame() ?? "").toContain("type to chat"); // back to the idle hint
});

test("Tag drops an @mention into the composer and hands typing back", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write(CTRL_U);
  await settle();
  stdin.write(DOWN); // bob
  await settle();
  stdin.write(ENTER); // menu: [Send DM, Tag in #rust]
  await settle();
  stdin.write(DOWN); // → Tag
  await settle();
  stdin.write(ENTER);
  await settle();
  expect(lastFrame() ?? "").toContain("@bob");
  // Focus is back on the composer, so typing lands in the draft again.
  stdin.write("yo");
  await settle();
  expect(lastFrame() ?? "").toContain("@bob yo");
});

test("an online expert on the roster gets a Call row that opens summon-confirm", async () => {
  let lounge: FakeSocket | undefined;
  let mkt: FakeSocket | undefined;
  const client = new LoungeClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    room: "rust",
    token: "tok",
    socketFactory: () => {
      lounge = new FakeSocket();
      return lounge;
    },
  });
  client.connect();
  const marketplace = new MarketplaceClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    token: "tok",
    socketFactory: () => {
      mkt = new FakeSocket();
      return mkt;
    },
  });
  marketplace.connect();
  lounge?.deliver({
    type: "roster",
    room: "rust",
    members: [
      { user: "alice", topic: null, verified: true },
      { user: "bob", topic: "rust", verified: true },
    ],
    guests: 0,
  });
  const { lastFrame, stdin } = render(
    <App client={client} marketplace={marketplace} user="alice" token="tok" />,
  );
  await settle();
  mkt?.deliver({
    type: "expert_list",
    experts: [
      {
        user: "bob",
        rate: 2.5,
        topics: ["rust"],
        rating: null,
        ratingCount: 0,
        sessions: 0,
        reputationTier: "new",
        topExpert: false,
        online: true,
      },
    ],
  });
  await settle();
  stdin.write(CTRL_U);
  await settle();
  stdin.write(DOWN); // bob
  await settle();
  stdin.write(ENTER);
  await settle();
  expect(lastFrame() ?? "").toContain("Call $2.5/min");
  stdin.write(DOWN); // Send DM → Tag
  stdin.write(DOWN); // → Call
  await settle();
  stdin.write(ENTER);
  await settle();
  // Money never starts from a list highlight: it hands off to the Experts tab's
  // summon-confirm, which wants a problem statement before it authorizes a hold.
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Describe your problem");
  expect(frame).toContain("bob");
});

test("a long roster scrolls to follow the highlight, and the open menu still fits", async () => {
  const prevRows = process.stdout.rows;
  (process.stdout as unknown as { rows: number }).rows = 20;
  try {
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
    socket?.deliver({
      type: "roster",
      room: "rust",
      members: Array.from({ length: 40 }, (_, i) => ({
        user: `member${String(i).padStart(2, "0")}`,
        topic: null,
        verified: false,
      })),
      guests: 0,
    });
    const { lastFrame, stdin } = render(<App client={client} user="alice" />);
    await settle();
    stdin.write(CTRL_U);
    await settle();
    // A held arrow key fires many keypresses inside one render — each must still step.
    for (let i = 0; i < 25; i++) stdin.write(DOWN);
    await settle();
    stdin.write(ENTER);
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("member25"); // walked the full 25 rows, not collapsed to one
    expect(frame).toContain("Send DM"); // its menu is open...
    expect(frame.split("\n").length).toBeLessThanOrEqual(19); // ...without overflowing
  } finally {
    (process.stdout as unknown as { rows: number | undefined }).rows = prevRows;
  }
});

test("clicking a roster name opens that member's menu (same path as Ctrl+U + Enter)", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  // SGR mouse press (ESC[<0;x;y M), left button, inside the sidebar on the 2nd member:
  // x lands in the right column, y = BODY_TOP + ROSTER_LIST_OFFSET + 1 (bob's row).
  const x = process.stdout.columns ?? 80;
  stdin.write(`\u001B[<0;${x - 5};${BODY_TOP + ROSTER_LIST_OFFSET + 1}M`);
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Send DM"); // bob's menu, not alice's (self) menu
  expect(frame).toContain("bob: ↑↓ choose");
});

// Pin ROSTER_LIST_OFFSET against the real render, the way the other list offsets are
// pinned: if someone adds a row of sidebar chrome, this fails instead of roster clicks
// silently landing one member off.
test("layout: the first roster member draws at BODY_TOP + ROSTER_LIST_OFFSET", async () => {
  const { lastFrame } = setup();
  await settle();
  const lines = (lastFrame() ?? "").split("\n");
  expect(lines[BODY_TOP - 1]).toContain("#RUST"); // the roster header row
  expect(lines[BODY_TOP + ROSTER_LIST_OFFSET - 1]).toContain("alice"); // first member
});

test("clicking a modal row runs it (mouse never has to hand off to the keyboard)", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  const x = (process.stdout.columns ?? 80) - 5;
  stdin.write(`\u001B[<0;${x};${BODY_TOP + ROSTER_LIST_OFFSET + 1}M`); // click bob in the roster
  await settle();
  expect(lastFrame() ?? "").toContain("Tag in #rust");
  // Find the modal's Tag row in the actual frame and click it where it really is — this
  // also pins that the box geometry handed to the hit-tester matches what was drawn.
  const lines = (lastFrame() ?? "").split("\n");
  const y = lines.findIndex((l) => l.includes("Tag in #rust")) + 1; // frames are 0-based
  // Column math must run on the PLAIN text: the frame carries SGR codes, which inflate
  // string indexes far past the real cell the label sits in.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const col = (lines[y - 1] ?? "").replace(ansi, "").indexOf("Tag in #rust") + 1;
  stdin.write(`\u001B[<0;${col};${y}M`);
  await settle();
  expect(lastFrame() ?? "").toContain("@bob");
});

// The modal is placed with margins (Ink has no absolute positioning), and the hit-tester
// is handed those same numbers. Pin them against the real frame so a layout change can't
// leave clicks landing on the wrong action — the failure this would otherwise cause is
// silent and lands on a MONEY row (Call sits in the same list).
test("layout: the modal's first action row is where the hit-tester says it is", async () => {
  const { lastFrame, stdin } = setup();
  await settle();
  stdin.write(CTRL_U);
  await settle();
  stdin.write(DOWN); // bob
  await settle();
  stdin.write(ENTER);
  await settle();
  const lines = (lastFrame() ?? "").split("\n");
  // The sidebar also carries "bob" and a "│", so anchor on the box's top border.
  const borderRow = lines.findIndex((l) => /[╭┌]/.test(l));
  const firstItemRow = lines.findIndex((l) => l.includes("Send DM"));
  expect(borderRow).toBeGreaterThan(0);
  expect(lines[borderRow + 1] ?? "").toContain("bob"); // title row, directly inside
  expect(firstItemRow).toBe(borderRow + 2); // first action, directly under the title
  // ...and the hint rides below a rule at the bottom of the same box.
  const hintRow = lines.findIndex((l) => l.includes("Esc cancel"));
  expect(hintRow).toBeGreaterThan(firstItemRow);
  expect(lines[hintRow + 1] ?? "").toMatch(/[╰└]/);
});
