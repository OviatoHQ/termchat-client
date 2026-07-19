import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DmInboxThread } from "@termchat/protocol";
import { DmController } from "../src/dm-controller.ts";
import { generateIdentity } from "../src/dm-crypto.ts";

// Fake DmClient — the controller only needs these methods; DmClient itself is tested
// separately. Records sends so we can assert delegation.
interface FakeLine {
  id: number;
  from: string;
  text: string;
  ts: number;
}
class FakeClient {
  sent: string[] = [];
  readMarks: number[] = [];
  connected = false;
  lines: FakeLine[] = [];
  private listener: ((s: unknown) => void) | null = null;
  getState(): { peer: string; connected: boolean; lines: FakeLine[]; self: null } {
    return { peer: "peer", connected: this.connected, lines: this.lines, self: null };
  }
  subscribe(l: (s: unknown) => void): () => void {
    this.listener = l;
    return () => {
      this.listener = null;
    };
  }
  connect(): void {
    this.connected = true;
  }
  /** Simulate a message arriving: push it and notify subscribers (drives markRead). */
  deliver(line: FakeLine): void {
    this.lines = [...this.lines, line];
    this.listener?.(this.getState());
  }
  sendMessage(text: string): void {
    this.sent.push(text);
  }
  markRead(id: number): void {
    this.readMarks.push(id);
  }
  close(): void {}
}

const me = generateIdentity();
const peer = generateIdentity();
const attacker = generateIdentity();

let home: string;
const prevHome = process.env.TERMCHAT_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "termchat-dmctl-"));
  process.env.TERMCHAT_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.TERMCHAT_HOME;
  else process.env.TERMCHAT_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

let lastClient: FakeClient;
function makeController(opts: {
  inbox?: DmInboxThread[];
  key?: Uint8Array | null;
  displayName?: string | null;
}): DmController {
  return new DmController({
    wsBase: "wss://edge.test",
    token: "tok",
    identity: me,
    fetchInbox: async () => opts.inbox ?? [],
    fetchKey: async (p) => {
      const k = opts.key === undefined ? peer.publicKey : opts.key;
      return k === null ? null : { key: k, handle: p, displayName: opts.displayName ?? null };
    },
    makeClient: () => {
      lastClient = new FakeClient();
      return lastClient as unknown as import("../src/dm-client.ts").DmClient;
    },
  });
}

describe("DmController", () => {
  test("refreshInbox populates the thread list", async () => {
    const threads: DmInboxThread[] = [{ peer: "bob", lastId: 5, lastTs: 100, unread: 2 }];
    const ctl = makeController({ inbox: threads });
    await ctl.refreshInbox();
    expect(ctl.getState().threads).toEqual(threads);
  });

  test("openThread pins a new key, computes the safety number, and connects", async () => {
    const ctl = makeController({ key: peer.publicKey });
    await ctl.openThread("bob");
    const s = ctl.getState();
    expect(s.activePeer).toBe("bob");
    expect(s.keyStatus).toBe("new");
    expect(s.safetyWords).toHaveLength(16);
    expect(s.error).toBeNull();
    expect(lastClient.connected).toBe(true);
  });

  test("reopening with the same key reads as pinned", async () => {
    const ctl = makeController({ key: peer.publicKey });
    await ctl.openThread("carol"); // first sight → new + pin
    await ctl.openThread("carol"); // same key → pinned
    expect(ctl.getState().keyStatus).toBe("pinned");
  });

  test("a changed key is flagged (TOFU MITM warning), pin not silently updated", async () => {
    const ctl = makeController({ key: peer.publicKey });
    await ctl.openThread("dave"); // pin peer's key
    const ctl2 = makeController({ key: attacker.publicKey });
    await ctl2.openThread("dave"); // different key for the same handle
    expect(ctl2.getState().keyStatus).toBe("changed");
  });

  test("opening a peer with no published key surfaces a friendly error", async () => {
    const ctl = makeController({ key: null });
    await ctl.openThread("ghost");
    const s = ctl.getState();
    expect(s.error).toContain("hasn't set up DMs");
    expect(s.active).toBeNull();
  });

  test("sendMessage delegates to the open thread's client", async () => {
    const ctl = makeController({ key: peer.publicKey });
    await ctl.openThread("bob");
    ctl.sendMessage("yo");
    expect(lastClient.sent).toEqual(["yo"]);
  });

  test("viewing a thread advances the read cursor to the newest message (unread clears)", async () => {
    let inboxCalls = 0;
    const ctl = new DmController({
      wsBase: "wss://edge.test",
      token: "tok",
      identity: me,
      fetchInbox: async () => {
        inboxCalls += 1;
        return [];
      },
      fetchKey: async (p) => ({ key: peer.publicKey, handle: p, displayName: null }),
      makeClient: () => {
        lastClient = new FakeClient();
        return lastClient as unknown as import("../src/dm-client.ts").DmClient;
      },
    });
    await ctl.openThread("bob");
    ctl.setFocused(true); // the DMs tab is on-screen
    lastClient.deliver({ id: 7, from: "bob", text: "hi", ts: 1 });
    lastClient.deliver({ id: 9, from: "bob", text: "you there?", ts: 2 });

    expect(lastClient.readMarks).toEqual([7, 9]); // marked read once per new id
    expect(inboxCalls).toBeGreaterThan(0); // inbox refreshed so the badge clears
  });

  test("an unfocused thread does NOT auto-read; focusing catches up (unread badge works)", async () => {
    const ctl = makeController({ key: peer.publicKey });
    await ctl.openThread("bob");
    // DMs tab NOT on-screen (you're on the Lounge): the reply must stay unread.
    lastClient.deliver({ id: 3, from: "bob", text: "you around?", ts: 1 });
    expect(lastClient.readMarks).toEqual([]); // not marked read while away

    // Returning to the DMs tab catches up the cursor to the newest message.
    ctl.setFocused(true);
    expect(lastClient.readMarks).toEqual([3]);
  });

  test("does not re-mark an id already read (fires at most once per message)", async () => {
    const ctl = makeController({ key: peer.publicKey });
    await ctl.openThread("bob");
    ctl.setFocused(true); // viewing the thread
    lastClient.deliver({ id: 5, from: "bob", text: "hi", ts: 1 });
    lastClient.deliver({ id: 5, from: "bob", text: "hi", ts: 1 }); // same id echoed again
    expect(lastClient.readMarks).toEqual([5]);
  });
});
