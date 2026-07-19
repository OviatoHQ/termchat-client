import { expect, test } from "bun:test";
import { PONG } from "@termchat/protocol";
import type { WebSocketLike } from "../src/lounge-client.ts";
import { PresenceNotifyClient } from "../src/presence-notify.ts";

class FakeSocket implements WebSocketLike {
  closed = false;
  private handlers: Record<string, (e: { data?: unknown }) => void> = {};
  send(): void {}
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, handler: (e: { data?: unknown }) => void): void {
    this.handlers[type] = handler;
  }
  recv(frame: unknown): void {
    this.handlers.message?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
}

function make(): { client: PresenceNotifyClient; socket: FakeSocket; nudges: string[] } {
  const socket = new FakeSocket();
  const nudges: string[] = [];
  const client = new PresenceNotifyClient({
    wsBase: "wss://edge.test",
    clientId: "c1",
    token: "tok",
    onDmNotify: (from) => nudges.push(from),
    socketFactory: () => socket,
  });
  client.connect();
  return { client, socket, nudges };
}

test("fires onDmNotify for a dm_notify push, carrying the sender", () => {
  const { socket, nudges } = make();
  socket.recv({ type: "dm_notify", from: "alice" });
  expect(nudges).toEqual(["alice"]);
});

test("ignores presence snapshots, PONGs, and junk", () => {
  const { socket, nudges } = make();
  socket.recv(PONG);
  socket.recv({ type: "presence", online: 3, waiting: 0, experts: 1, ts: 1 });
  socket.recv("not json");
  expect(nudges).toEqual([]);
});

test("close() tears down the socket and suppresses reconnect", () => {
  const { client, socket } = make();
  client.close();
  expect(socket.closed).toBe(true);
});
