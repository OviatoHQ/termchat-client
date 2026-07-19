import { beforeEach, describe, expect, test } from "bun:test";
import { ClientDmMessage } from "@termchat/protocol";
import { DmClient } from "../src/dm-client.ts";
import { derivePairKey, generateIdentity, seal } from "../src/dm-crypto.ts";
import type { WebSocketLike } from "../src/lounge-client.ts";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  private handlers: Record<string, (e: { data?: unknown }) => void> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  addEventListener(type: string, handler: (e: { data?: unknown }) => void): void {
    this.handlers[type] = handler;
  }
  emit(type: "open" | "close" | "error" | "message", data?: unknown): void {
    this.handlers[type]?.({ data });
  }
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? "{}");
  }
  recv(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
}

// Fixed identities so the client's pair key is derivable in the test, and we can seal
// inbound frames the client will be able to open (ECDH is symmetric).
const me = generateIdentity();
const peer = generateIdentity();
const pairKey = derivePairKey(peer.privateKey, me.publicKey); // == client's own pair key

let socket: FakeSocket;
let ids: number;

function makeClient(): DmClient {
  socket = new FakeSocket();
  ids = 0;
  const client = new DmClient({
    wsBase: "wss://edge.test",
    token: "tok",
    peer: "peeruser",
    identity: me,
    peerPublicKey: peer.publicKey,
    socketFactory: () => socket,
    idFactory: () => {
      ids += 1;
      return `cid-${ids}`;
    },
  });
  client.connect();
  socket.emit("open"); // model the completed WS handshake (sends flush once open)
  return client;
}

/** A server dm_message frame the client can decrypt, sealed under the shared key. */
function serverMessage(
  id: number,
  from: string,
  text: string,
  clientMsgId?: string,
): Record<string, unknown> {
  const sealed = seal(pairKey, text);
  return {
    type: "dm_message",
    message: {
      id,
      from,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      ts: 1000 + id,
      ...(clientMsgId ? { clientMsgId } : {}),
    },
  };
}

beforeEach(() => {
  ids = 0;
});

describe("DmClient", () => {
  test("dm_ready sets self and peer", () => {
    const client = makeClient();
    socket.recv({ type: "dm_ready", self: "me", peer: "peeruser" });
    expect(client.getState().self).toBe("me");
    expect(client.getState().peer).toBe("peeruser");
  });

  test("sendMessage shows an optimistic pending line and sends sealed ciphertext", () => {
    const client = makeClient();
    socket.recv({ type: "dm_ready", self: "me", peer: "peeruser" });
    client.sendMessage("yo bro ssup");

    const line = client.getState().lines[0];
    expect(line).toMatchObject({ from: "me", text: "yo bro ssup", pending: true });
    const frame = socket.lastSent();
    expect(frame.type).toBe("dm_send");
    expect(frame.clientMsgId).toBe("cid-1");
    // The wire carries ciphertext, never the plaintext.
    expect(JSON.stringify(frame)).not.toContain("yo bro ssup");
    // Contract: a REAL seal() frame must satisfy the edge's Zod envelope (nonce/
    // ciphertext base64 sizes) — pins the client↔edge wire against future drift.
    expect(ClientDmMessage.safeParse(frame).success).toBe(true);
  });

  test("the server echo reconciles the optimistic line (real id, not pending, no dup)", () => {
    const client = makeClient();
    socket.recv({ type: "dm_ready", self: "me", peer: "peeruser" });
    client.sendMessage("hello");
    const cid = String(socket.lastSent().clientMsgId);

    socket.recv(serverMessage(42, "me", "hello", cid));
    const { lines } = client.getState();
    expect(lines).toHaveLength(1); // reconciled, not duplicated
    expect(lines[0]).toMatchObject({ id: 42, pending: false });
  });

  test("an inbound peer message is decrypted and appended", () => {
    const client = makeClient();
    socket.recv({ type: "dm_ready", self: "me", peer: "peeruser" });
    socket.recv(serverMessage(7, "peeruser", "hey there"));

    const line = client.getState().lines.at(-1);
    expect(line).toMatchObject({ id: 7, from: "peeruser", text: "hey there" });
    expect(line?.undecryptable).toBeFalsy();
  });

  test("a backlog batch is ingested in order and decrypted", () => {
    const client = makeClient();
    socket.recv({
      type: "dm_backlog",
      messages: [
        serverMessage(1, "peeruser", "first").message,
        serverMessage(2, "me", "second").message,
      ],
    });
    expect(client.getState().lines.map((l) => l.text)).toEqual(["first", "second"]);
  });

  test("a duplicate server id is ignored", () => {
    const client = makeClient();
    socket.recv(serverMessage(5, "peeruser", "once"));
    socket.recv(serverMessage(5, "peeruser", "once"));
    expect(client.getState().lines).toHaveLength(1);
  });

  test("ciphertext that can't be opened is flagged undecryptable", () => {
    const client = makeClient();
    // Seal under a DIFFERENT key so the client's pair key can't open it.
    const strangerKey = derivePairKey(generateIdentity().privateKey, generateIdentity().publicKey);
    const sealed = seal(strangerKey, "secret");
    socket.recv({
      type: "dm_message",
      message: {
        id: 9,
        from: "peeruser",
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        ts: 1,
      },
    });
    const line = client.getState().lines.at(-1);
    expect(line).toMatchObject({ id: 9, undecryptable: true, text: "" });
  });

  test("sendMessage encrypts round-trip: the sealed frame opens back to the plaintext", () => {
    const client = makeClient();
    client.sendMessage("round trip");
    const frame = socket.lastSent();
    // Simulate the server echoing it to the peer; a fresh peer-side client decrypts it.
    const peerClient = new DmClient({
      wsBase: "wss://edge.test",
      token: "t",
      peer: "me",
      identity: peer,
      peerPublicKey: me.publicKey,
      socketFactory: () => new FakeSocket(),
      idFactory: () => "x",
    });
    peerClient.connect();
    (peerClient as unknown as { apply: (m: unknown) => void }).apply({
      type: "dm_message",
      message: {
        id: 1,
        from: "me",
        nonce: frame.nonce,
        ciphertext: frame.ciphertext,
        ts: 1,
        clientMsgId: frame.clientMsgId,
      },
    });
    expect(peerClient.getState().lines.at(-1)?.text).toBe("round trip");
  });

  test("buffers a send during the handshake and flushes it on open (inline /dm race)", () => {
    const s = new FakeSocket();
    const client = new DmClient({
      wsBase: "wss://edge.test",
      token: "tok",
      peer: "peeruser",
      identity: me,
      peerPublicKey: peer.publicKey,
      socketFactory: () => s,
      idFactory: () => "cid-1",
    });
    client.connect();
    // Send BEFORE the socket opens — this is the `/dm <user> <msg>` first line, which
    // fires right after connect() while the WS is still handshaking.
    client.sendMessage("first line");
    // The optimistic line shows immediately, but nothing is on the wire yet…
    expect(client.getState().lines[0]).toMatchObject({ text: "first line", pending: true });
    expect(s.sent.length).toBe(0);
    // …until the handshake completes, when the queued frame flushes to the server.
    s.emit("open");
    expect(s.sent.length).toBe(1);
    expect(JSON.parse(s.sent[0] ?? "{}").type).toBe("dm_send");
  });
});
