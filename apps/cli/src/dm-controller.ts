import { DmInboxResponse, type DmInboxThread } from "@termchat/protocol";
import { DmClient, type DmState } from "./dm-client.ts";
import {
  type Identity,
  fetchPublicKey,
  loadOrCreateIdentity,
  publishPublicKey,
  safetyNumber,
} from "./dm-crypto.ts";
import { loadPins, savePins } from "./dm-pins.ts";

/**
 * Headless controller for the DMs tab (docs/DMS.md stage 3b): owns the inbox thread
 * list, the currently-open thread's {@link DmClient}, TOFU key-pinning, and the safety
 * number for the header. The Ink view is a thin layer over its observable state — so
 * all behaviour is unit-testable. Network + socket are injectable for tests.
 */

/** TOFU verdict for the open thread's key: first sight, matches the pin, or CHANGED. */
export type KeyStatus = "new" | "pinned" | "changed";

export interface DmControllerState {
  /** Inbox thread list (peer · last · unread), newest-first. */
  threads: DmInboxThread[];
  /** The open thread peer's CANONICAL handle (stable — routes/pins the thread). */
  activePeer: string | null;
  /** The open peer's current display name (`/nick`), for labels; falls back to the handle. */
  activeLabel: string | null;
  /** The open thread's decrypted conversation state, or null when none is open. */
  active: DmState | null;
  /** Word safety number for the open thread (empty when none open). */
  safetyWords: string[];
  keyStatus: KeyStatus | null;
  error: string | null;
}

export interface DmControllerOptions {
  wsBase: string;
  token: string;
  identity: Identity;
  /** List the user's threads (defaults to GET /dm/inbox via the caller's fetcher). */
  fetchInbox: () => Promise<DmInboxThread[]>;
  /** Fetch a peer's public key + canonical handle + display name (defaults to the edge). */
  fetchKey?: (
    peer: string,
  ) => Promise<{ key: Uint8Array; handle: string; displayName: string | null } | null>;
  /** Construct the per-thread client (injectable for tests). */
  makeClient?: (opts: { peer: string; peerPublicKey: Uint8Array }) => DmClient;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const EMPTY: DmControllerState = {
  threads: [],
  activePeer: null,
  activeLabel: null,
  active: null,
  safetyWords: [],
  keyStatus: null,
  error: null,
};

export class DmController {
  private readonly options: DmControllerOptions;
  private state: DmControllerState = EMPTY;
  private readonly listeners = new Set<(state: DmControllerState) => void>();
  private activeClient: DmClient | null = null;
  private unsubscribeActive: (() => void) | null = null;
  /** Highest server id already marked read in the open thread (0 = none yet). */
  private lastMarkedId = 0;
  /** Whether the DMs tab (the open thread) is currently on-screen. Gates auto-read. */
  private focused = false;

  constructor(options: DmControllerOptions) {
    this.options = options;
  }

  getState(): DmControllerState {
    return this.state;
  }

  subscribe(listener: (state: DmControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reload the inbox (thread list + unread counts). Failures keep the last list. */
  async refreshInbox(): Promise<void> {
    try {
      this.patch({ threads: await this.options.fetchInbox() });
    } catch {
      // keep the last-known inbox; the tab still works from cache
    }
  }

  /** Open (or switch to) a conversation with `peer`: fetch + TOFU-check their key, wire
   *  up a live client, and compute the safety number. */
  async openThread(typed: string): Promise<void> {
    const fetchKey = this.options.fetchKey ?? fetchPublicKey;
    let result: { key: Uint8Array; handle: string; displayName: string | null } | null;
    try {
      result = await fetchKey(typed);
    } catch {
      this.patch({ error: `Couldn't reach ${typed} right now.`, activePeer: typed });
      return;
    }
    if (!result) {
      this.teardownActive();
      this.patch({
        activePeer: typed,
        activeLabel: typed,
        active: null,
        safetyWords: [],
        keyStatus: null,
        error: `${typed} hasn't set up DMs yet.`,
      });
      return;
    }

    // Canonicalize to the stable identity handle the directory returned: pin, connect,
    // and route the thread by the HANDLE (a display-name rename can't fork the thread or
    // spoof a TOFU pin). The current display name is carried separately, for labels only.
    const { key, handle, displayName } = result;
    const label = displayName ?? handle;
    const keyStatus = this.pinAndClassify(handle, key);
    this.teardownActive();
    this.lastMarkedId = 0;

    const client = this.options.makeClient
      ? this.options.makeClient({ peer: handle, peerPublicKey: key })
      : new DmClient({
          wsBase: this.options.wsBase,
          token: this.options.token,
          peer: handle,
          identity: this.options.identity,
          peerPublicKey: key,
        });
    this.activeClient = client;
    this.unsubscribeActive = client.subscribe((dm) => {
      this.patch({ active: dm });
      // Only advance the read cursor when the thread is actually ON-SCREEN (the DMs tab
      // is focused). If the user is on another tab, incoming messages must accumulate as
      // unread so the DMs-tab badge lights up — the live socket being connected is NOT
      // the same as the user reading it.
      if (this.focused) this.markLatestRead(dm);
    });
    client.connect();

    this.patch({
      activePeer: handle,
      activeLabel: label,
      active: client.getState(),
      safetyWords: safetyNumber(this.options.identity.publicKey, key),
      keyStatus,
      error: null,
    });
  }

  /** Tell the controller whether the DMs tab (the open thread) is on-screen. When it
   *  becomes focused, catch up the read cursor on anything that arrived while away (so
   *  the badge clears); when it isn't, incoming messages accumulate as unread. */
  setFocused(focused: boolean): void {
    this.focused = focused;
    if (focused) this.markLatestRead(this.state.active);
  }

  /** Send a message in the open thread. */
  sendMessage(text: string): void {
    this.activeClient?.sendMessage(text);
  }

  /** Advance the read cursor for the open thread (drives unread + offline replay). */
  markRead(upToId: number): void {
    this.activeClient?.markRead(upToId);
  }

  /** Advance the read cursor to the newest persisted message, once per new id, and
   *  refresh the inbox so the thread's unread badge clears. Ignores optimistic (id≤0)
   *  and already-marked ids so it fires at most once per delivered message. */
  private markLatestRead(dm: DmState | null): void {
    if (!dm) return;
    let maxId = 0;
    for (const line of dm.lines) if (line.id > maxId) maxId = line.id;
    if (maxId <= this.lastMarkedId) return;
    this.lastMarkedId = maxId;
    this.activeClient?.markRead(maxId);
    void this.refreshInbox();
  }

  close(): void {
    this.teardownActive();
  }

  /** Pin on first sight; classify against the pin. A CHANGED key keeps the old pin so
   *  the header warns until the user re-verifies (never silently re-trust). */
  private pinAndClassify(peer: string, key: Uint8Array): KeyStatus {
    const pins = loadPins();
    const pinned = pins[peer];
    const keyB64 = toB64(key);
    if (!pinned) {
      pins[peer] = keyB64;
      savePins(pins);
      return "new";
    }
    return pinned === keyB64 ? "pinned" : "changed";
  }

  private teardownActive(): void {
    this.unsubscribeActive?.();
    this.unsubscribeActive = null;
    this.activeClient?.close();
    this.activeClient = null;
  }

  private patch(partial: Partial<DmControllerState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }
}

/**
 * Build a live DM controller for a signed-in user: loads/creates this machine's
 * identity, publishes its public key so peers can reach us (best-effort), and wires the
 * inbox fetcher against `GET /dm/inbox`. Used at launch and on in-TUI `/login`.
 */
export function createDmController(config: {
  wsBase: string;
  httpBase: string;
  token: string;
}): DmController {
  const identity = loadOrCreateIdentity();
  // Publish so the other side can fetch our key and DM back. Non-blocking; a failure
  // just means we're not yet reachable (retried next launch).
  void publishPublicKey(identity.publicKey).catch(() => {});
  return new DmController({
    wsBase: config.wsBase,
    token: config.token,
    identity,
    fetchInbox: async () => {
      try {
        const res = await fetch(`${config.httpBase}/dm/inbox`, {
          headers: { authorization: `Bearer ${config.token}` },
        });
        if (!res.ok) return [];
        const parsed = DmInboxResponse.safeParse(await res.json());
        return parsed.success ? parsed.data.threads : [];
      } catch {
        return [];
      }
    },
  });
}
