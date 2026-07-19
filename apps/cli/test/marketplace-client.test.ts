import { expect, test } from "bun:test";
import { AUTH_SUBPROTOCOL, type ServerMarketplaceMessage } from "@termchat/protocol";
import type { WebSocketLike } from "../src/lounge-client.ts";
import { MarketplaceClient } from "../src/marketplace-client.ts";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  url: string;
  protocols: string[] | undefined;
  private handlers = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  deliver(message: ServerMarketplaceMessage): void {
    for (const h of this.handlers.get("message") ?? []) h({ data: JSON.stringify(message) });
  }
  lastSent(): unknown {
    return JSON.parse(this.sent.at(-1) ?? "null");
  }
}

function make(): { client: MarketplaceClient; sock: FakeSocket } {
  let sock: FakeSocket | undefined;
  const client = new MarketplaceClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    token: "tok",
    socketFactory: (url, protocols) => {
      sock = new FakeSocket(url, protocols);
      return sock;
    },
  });
  client.connect();
  return { client, sock: sock as FakeSocket };
}

test("connects with the auth subprotocol", () => {
  const { sock } = make();
  expect(sock.protocols).toEqual([AUTH_SUBPROTOCOL, "tok"]);
  expect(sock.url).toContain("/marketplace?clientId=c1");
});

test("expert_on / summon emit validated client frames", () => {
  const { client, sock } = make();
  client.expertOn(2, ["rust"]);
  expect(sock.lastSent()).toEqual({ type: "expert_on", rate: 2, topics: ["rust"] });
  client.summon({ problem: "borrow checker", maxRate: 5 });
  expect(sock.lastSent()).toEqual({ type: "summon", problem: "borrow checker", maxRate: 5 });
});

test("experts / bounties / my_sessions request the browsable lists", () => {
  const { client, sock } = make();
  client.experts();
  expect(sock.lastSent()).toEqual({ type: "experts" });
  client.bounties();
  expect(sock.lastSent()).toEqual({ type: "bounties" });
  client.mySessions();
  expect(sock.lastSent()).toEqual({ type: "my_sessions" });
});

test("review targets a specific session when a sessionId is given", () => {
  const { client, sock } = make();
  // Deliver an ended session so the default path also has a target.
  sock.deliver({
    type: "session_end",
    sessionId: 3,
    role: "seeker",
    minutes: 5,
    chargeCents: 500,
    feeCents: 0,
    payoutCents: 0,
    reason: "ended",
  });
  expect(client.review(5, "great", 12)).toBe(true); // explicit id wins
  expect(sock.lastSent()).toEqual({ type: "review", sessionId: 12, stars: 5, text: "great" });
});

test("accept defaults to the most recent offer; returns false when none", () => {
  const { client, sock } = make();
  expect(client.accept()).toBe(false); // no offer yet
  sock.deliver({
    type: "summon_request",
    reqId: "r1",
    from: "ben",
    topic: "rust",
    problem: "x",
    rate: 2,
    maxMinutes: 10,
  });
  expect(client.accept()).toBe(true);
  expect(sock.lastSent()).toEqual({ type: "accept", reqId: "r1" });
});

test("tracks active + last-ended session for ergonomic /review", () => {
  const { client, sock } = make();
  sock.deliver({
    type: "session_start",
    sessionId: 7,
    peer: "ada",
    role: "seeker",
    rate: 2,
    maxMinutes: 10,
    problem: "x",
  });
  expect(client.activeSessionId).toBe(7);
  sock.deliver({
    type: "session_end",
    sessionId: 7,
    role: "seeker",
    minutes: 1,
    chargeCents: 200,
    feeCents: 50,
    payoutCents: 150,
    reason: "ended",
  });
  expect(client.activeSessionId).toBeNull();
  expect(client.lastEndedSessionId).toBe(7);
  expect(client.review(5, "great")).toBe(true);
  expect(sock.lastSent()).toEqual({ type: "review", sessionId: 7, stars: 5, text: "great" });
});

test("subscribers receive validated server messages", () => {
  const { client, sock } = make();
  const seen: string[] = [];
  client.subscribe((m) => seen.push(m.type));
  sock.deliver({ type: "expert_ok", rate: 2, topics: [] });
  sock.deliver({ type: "earnings", lifetimeCents: 150, sessions: 1 });
  expect(seen).toEqual(["expert_ok", "earnings"]);
});
