/**
 * Where the marketplace event log shows up, and who asks the marketplace for data.
 *
 * Both pinned because of one bug: a guest's tab switch fired `experts()`/`bounties()`
 * on an unauthenticated socket, the edge answered "sign in first" for every frame, and
 * the log rendered on EVERY tab — so the rejection followed you back into the Lounge and
 * sat over the chat until restart.
 */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LoungeClient, type WebSocketLike } from "../src/lounge-client.ts";
import { MarketplaceClient } from "../src/marketplace-client.ts";
import { App } from "../src/tui/App.tsx";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
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
  types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }
}

const TAB = "\t";
const ALT_1 = "\u001B1"; // Alt+1 → the Lounge
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
process.stdout.setMaxListeners(0);

function setup(user: string | null) {
  let lounge: FakeSocket | undefined;
  let mkt: FakeSocket | undefined;
  const client = new LoungeClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    room: "general",
    ...(user ? { token: "tok" } : {}),
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
  const app = render(<App client={client} marketplace={marketplace} user={user} token="tok" />);
  return { ...app, mkt: mkt as FakeSocket, lounge: lounge as FakeSocket };
}

test("a guest's tab switches ask the marketplace for nothing", async () => {
  const { stdin, mkt } = setup(null);
  await settle();
  for (let i = 0; i < 5; i++) {
    stdin.write(TAB); // walk the whole strip: dms → experts → bounties → calls → me
    await settle();
  }
  // Un-gated, entering Experts/Bounties/Calls would have sent three requests the edge
  // can only reject — one "sign in first" per switch, forever.
  expect(mkt.types()).not.toContain("experts");
  expect(mkt.types()).not.toContain("bounties");
  expect(mkt.types()).not.toContain("my_sessions");
});

test("a signed-in user's tab switches still refresh that tab's data", async () => {
  const { stdin, mkt } = setup("alice");
  await settle();
  stdin.write(TAB); // → dms
  await settle();
  stdin.write(TAB); // → experts
  await settle();
  expect(mkt.types()).toContain("experts");
});

test("the marketplace log shows on marketplace tabs and never follows you to the Lounge", async () => {
  const { lastFrame, stdin, mkt } = setup("alice");
  await settle();
  stdin.write(TAB); // dms
  await settle();
  stdin.write(TAB); // experts
  await settle();
  mkt.deliver({ type: "system", text: "Sign in with /login first." });
  await settle();
  expect(lastFrame() ?? "").toContain("Sign in with /login first.");
  // Back to the Lounge: the log is a marketplace surface, not chat furniture.
  stdin.write(ALT_1);
  await settle();
  const lounge = lastFrame() ?? "";
  expect(lounge).toContain("[LOUNGE]");
  expect(lounge).not.toContain("Sign in with /login first.");
});

test("a stale saved session stands down to guest instead of spamming the marketplace", async () => {
  const { lastFrame, stdin, mkt, lounge } = setup("alice");
  await settle();
  // The edge's verdict: this socket is NOT verified (expired token / another env), and the
  // lounge handed us a guest name instead.
  lounge.deliver({ type: "identity", user: "calm-salmon", verified: false });
  await settle();
  expect(lastFrame() ?? "").toContain("isn't valid on this server");
  expect(lastFrame() ?? "").toContain("[calm-salmon]"); // no (✓) beside a guest name
  const before = mkt.types().length;
  for (let i = 0; i < 5; i++) {
    stdin.write(TAB); // walk every tab — none of them may ask the marketplace anything
    await settle();
  }
  expect(mkt.types().length).toBe(before);
});

test("an identical rejection doesn't stack a new line each time", async () => {
  const { lastFrame, stdin, mkt } = setup("alice");
  await settle();
  stdin.write(TAB);
  await settle();
  stdin.write(TAB); // experts
  await settle();
  for (let i = 0; i < 3; i++) {
    mkt.deliver({ type: "system", text: "Sign in with /login first." });
    await settle();
  }
  const hits = (lastFrame() ?? "").split("Sign in with /login first.").length - 1;
  expect(hits).toBe(1);
});

test("a call fired from the Lounge shows its outcome there, not just on a market tab", async () => {
  // The bug: `/call --code … @afxal …` from the Lounge left "Calling afxal (free call)…"
  // up forever. The edge HAD answered ("afxal isn't online right now") — but that answer
  // only draws in the market log, which the Lounge doesn't show. The call looked live and
  // was already dead. The outcome now mirrors onto the notice row, which every tab draws.
  const { lastFrame, stdin, mkt } = setup("alice");
  await settle();
  stdin.write("/call --code LFGGG @afxal hello");
  await settle();
  stdin.write("\r");
  await settle();
  expect(lastFrame() ?? "").toContain("Calling afxal (free call)…");
  mkt.deliver({ type: "system", text: "afxal isn't online right now." });
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("[LOUNGE]"); // still standing in the Lounge
  expect(frame).toContain("afxal isn't online right now.");
  expect(frame).not.toContain("Calling afxal (free call)…"); // the dead call is gone
});

test("ordinary market chatter never colonises the notice row", async () => {
  const { lastFrame, mkt } = setup("alice");
  await settle();
  // No call in flight → a system message belongs in the market log only.
  mkt.deliver({ type: "system", text: "Sign in with /login first." });
  await settle();
  expect(lastFrame() ?? "").not.toContain("Sign in with /login first.");
});

test("an incoming call reaches the expert in the Lounge, in amber, with how to answer", async () => {
  // The other half of the same bug: `summon_request` only ever rendered in the market
  // log, so an expert sitting on the default tab was never told anyone was calling —
  // the caller watched "waiting…" until it expired against a live, idle expert.
  const { lastFrame, mkt } = setup("alice");
  await settle();
  mkt.deliver({
    type: "summon_request",
    reqId: "r1",
    from: "bob",
    topic: null,
    problem: "hello",
    rate: 2,
    maxMinutes: 30,
    free: true,
  });
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("[LOUNGE]"); // never left the chat tab
  expect(frame).toContain("bob needs help");
  expect(frame).toContain("/accept");
  expect(frame).toContain("/decline");
  expect(frame).toContain("⚡"); // ⚡ — the amber call marker
});

test("a live session shows on the chat tabs, and stops looking live when it ends", async () => {
  const { lastFrame, mkt } = setup("alice");
  await settle();
  mkt.deliver({
    type: "session_start",
    sessionId: 7,
    peer: "bob",
    role: "seeker",
    rate: 2,
    maxMinutes: 30,
    problem: "hello",
  });
  await settle();
  expect(lastFrame() ?? "").toContain("session #7 with bob");
  mkt.deliver({
    type: "session_end",
    sessionId: 7,
    role: "seeker",
    minutes: 3,
    chargeCents: 600,
    feeCents: 60,
    payoutCents: 540,
    reason: "ended",
  });
  await settle();
  expect(lastFrame() ?? "").toContain("session #7 ended");
});

test("an invitation someone else answered stops flashing", async () => {
  // Two experts get the same offer; the other one accepts. Without this, the loser's
  // amber "come help bob — /accept" sat up forever, and /accept only said it was gone.
  const { lastFrame, mkt } = setup("alice");
  await settle();
  mkt.deliver({
    type: "summon_request",
    reqId: "r1",
    from: "bob",
    topic: null,
    problem: "hello",
    rate: 2,
    maxMinutes: 30,
  });
  await settle();
  expect(lastFrame() ?? "").toContain("/accept");
  mkt.deliver({ type: "summon_closed", reqId: "r1" });
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("answered by someone else");
  expect(frame).not.toContain("bob needs help");
});

test("an offer's own refusals reach the recipient too, not just the caller", async () => {
  // Accepting a beaten offer is answered by a `system` line. The recipient never typed
  // /call, so a caller-only rule would leave that answer stuck in the market log.
  const { lastFrame, mkt } = setup("alice");
  await settle();
  mkt.deliver({
    type: "summon_request",
    reqId: "r1",
    from: "bob",
    topic: null,
    problem: "hello",
    rate: 2,
    maxMinutes: 30,
  });
  await settle();
  mkt.deliver({ type: "system", text: "That request is gone (taken or cancelled)." });
  await settle();
  expect(lastFrame() ?? "").toContain("That request is gone");
});

test("declining retracts the invitation, which the edge answers with silence", async () => {
  const { lastFrame, stdin, mkt } = setup("alice");
  await settle();
  mkt.deliver({
    type: "summon_request",
    reqId: "r1",
    from: "bob",
    topic: null,
    problem: "hello",
    rate: 2,
    maxMinutes: 30,
  });
  await settle();
  stdin.write("/decline");
  await settle();
  stdin.write("\r");
  await settle();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Declined.");
  expect(frame).not.toContain("bob needs help");
});
