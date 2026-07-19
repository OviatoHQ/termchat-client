import { expect, test } from "bun:test";
import { AUTH_SUBPROTOCOL } from "@termchat/protocol";
import { LoungeClient, type WebSocketLike } from "../src/lounge-client.ts";

/** A controllable fake socket for driving the client deterministically. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
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
  close(): void {
    this.closed = true;
    this.fire("close");
  }
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

function makeClient(token?: string): { client: LoungeClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const client = new LoungeClient({
    wsBase: "ws://edge.test",
    clientId: "c1",
    room: "rust",
    ...(token ? { token } : {}),
    socketFactory: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
  return { client, sockets };
}

test("connect carries the auth subprotocol only when a token is present", () => {
  const { client: anon, sockets: anonSockets } = makeClient();
  anon.connect();
  expect(anonSockets[0]?.protocols).toBeUndefined();

  const { client: authed, sockets: authedSockets } = makeClient("tok");
  authed.connect();
  expect(authedSockets[0]?.protocols).toEqual([AUTH_SUBPROTOCOL, "tok"]);
});

test("applies roster and msg server messages to state", () => {
  const { client, sockets } = makeClient("tok");
  client.connect();
  const s = sockets[0];
  if (!s) throw new Error("no socket");
  s.fire("open");
  expect(client.getState().connected).toBe(true);

  s.deliver({
    type: "roster",
    room: "rust",
    members: [{ user: "alice", topic: "rust", verified: true }],
    guests: 2,
  });
  expect(client.getState().members).toEqual([{ user: "alice", topic: "rust", verified: true }]);
  expect(client.getState().guests).toBe(2);

  s.deliver({ type: "msg", from: "alice", text: "hi", ts: 1 });
  expect(client.getState().lines.at(-1)).toMatchObject({ kind: "msg", from: "alice", text: "hi" });
});

test("identity message updates self + verified; setNick emits a nick frame", () => {
  const { client, sockets } = makeClient();
  client.connect();
  const s = sockets[0];
  if (!s) throw new Error("no socket");
  s.deliver({ type: "identity", user: "brave-otter-7k", verified: false });
  expect(client.getState().self).toBe("brave-otter-7k");
  expect(client.getState().verified).toBe(false);

  client.setNick("  neo  ");
  expect(JSON.parse(s.sent.at(-1) ?? "{}")).toEqual({ type: "nick", name: "neo" });
});

test("sendMessage and setTopic emit validated client frames", () => {
  const { client, sockets } = makeClient("tok");
  client.connect();
  const s = sockets[0];
  if (!s) throw new Error("no socket");
  client.sendMessage("  hello  ");
  client.setTopic("docker");
  expect(JSON.parse(s.sent[0] ?? "{}")).toEqual({ type: "msg", text: "hello" });
  expect(JSON.parse(s.sent[1] ?? "{}")).toEqual({ type: "topic", tag: "docker" });
});

test("switchRoom closes the old socket, resets state, and opens a new one", () => {
  const { client, sockets } = makeClient("tok");
  client.connect();
  sockets[0]?.deliver({ type: "msg", from: "x", text: "old", ts: 1 });
  expect(client.getState().lines.length).toBe(1);

  client.switchRoom("python");
  expect(sockets[0]?.closed).toBe(true);
  expect(client.getState().room).toBe("python");
  expect(client.getState().lines.length).toBe(0); // transcript cleared
  expect(sockets[1]?.url).toContain("room=python");
});

test("subscribers are notified on state change and can unsubscribe", () => {
  const { client, sockets } = makeClient("tok");
  let calls = 0;
  const unsub = client.subscribe(() => {
    calls += 1;
  });
  client.connect();
  sockets[0]?.fire("open");
  expect(calls).toBeGreaterThan(0);
  const after = calls;
  unsub();
  sockets[0]?.deliver({ type: "system", text: "later" });
  expect(calls).toBe(after); // no further notifications
});

test("reauthenticate reconnects with a new token and flips verified", () => {
  const { client, sockets } = makeClient(); // start anonymous
  client.connect();
  expect(sockets[0]?.protocols).toBeUndefined(); // no auth subprotocol as guest
  expect(client.getState().verified).toBe(false);

  client.reauthenticate("tok-123"); // /login
  expect(client.getState().verified).toBe(true);
  expect(sockets[1]?.protocols).toEqual([AUTH_SUBPROTOCOL, "tok-123"]); // reconnected authed

  client.reauthenticate(undefined); // /logout
  expect(client.getState().verified).toBe(false);
  expect(sockets[2]?.protocols).toBeUndefined();
});
