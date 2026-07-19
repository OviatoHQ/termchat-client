import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_SUBPROTOCOL,
  DmNotify,
  OnlineResponse,
  PING,
  PONG,
  PresenceSnapshot,
} from "@termchat/protocol";
import {
  ensureHome,
  getOrCreateClientId,
  pidPath,
  readCredentials,
  resolveEdge,
} from "./config.ts";
import { writeCounts } from "./line.ts";
import { crossedExpertAvailable, notifyDmReceived, notifyExpertAvailable } from "./notify.ts";

const PING_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const WARM_TIMEOUT_MS = 2_000;

/** Is a live presence daemon already holding the socket for this machine? */
export function isDaemonRunning(): boolean {
  const path = pidPath();
  if (!existsSync(path)) return false;
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, sends nothing
    return true;
  } catch {
    return false; // stale pidfile (process gone)
  }
}

/**
 * Spawn a detached presence daemon if none is running. Called by the
 * `SessionStart` hook. Returns immediately; never blocks Claude Code.
 */
export function ensureDaemonRunning(): void {
  if (process.env.TERMCHAT_DISABLE_DAEMON_SPAWN === "1") return;
  if (isDaemonRunning()) return;
  const cliEntry = join(import.meta.dir, "cli.ts");
  const child = Bun.spawn([process.execPath, cliEntry, "daemon"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref(); // survive the hook process exiting
}

/**
 * Run the presence daemon: hold one hibernatable WebSocket, and atomically
 * mirror every presence broadcast to `~/.termchat/online.line`. This is the
 * ONLY component that touches the network — the status line just reads the file.
 */
export async function runDaemon(): Promise<void> {
  if (isDaemonRunning()) return; // another daemon already owns the socket
  ensureHome();
  writeFileSync(pidPath(), `${process.pid}\n`);

  const clientId = getOrCreateClientId();
  const { httpBase, wsBase } = resolveEdge();

  const cleanup = (): void => {
    try {
      if (existsSync(pidPath()) && readFileSync(pidPath(), "utf8").trim() === String(process.pid)) {
        rmSync(pidPath());
      }
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Carry the verified identity on the socket via the WebSocket subprotocol
  // header (never the URL) when logged in; anonymous otherwise.
  const credentials = readCredentials();
  const protocols = credentials ? [AUTH_SUBPROTOCOL, credentials.token] : undefined;

  await warm(httpBase);
  connect(`${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`, protocols);
  // The open WebSocket + ping timer keep the event loop alive indefinitely.
}

/** Seed the line from `GET /online` so the status bar is correct immediately. */
async function warm(httpBase: string): Promise<void> {
  try {
    const res = await fetch(`${httpBase}/online`, { signal: AbortSignal.timeout(WARM_TIMEOUT_MS) });
    if (!res.ok) return;
    const parsed = OnlineResponse.safeParse(await res.json());
    if (parsed.success) writeCounts(parsed.data);
  } catch {
    // Edge not up yet — the WS stream will fill the line in shortly.
  }
}

let reconnectAttempts = 0;
/** Last seen experts count — so an "expert available" notification fires once on the
 *  0→≥1 edge, not on every snapshot or reconnect. */
let lastExperts = 0;

function connect(url: string, protocols?: string[]): void {
  const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
  let settled = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    pingTimer = setInterval(() => {
      try {
        ws.send(PING); // auto-responded with PONG; never wakes the DO
      } catch {
        // socket gone; the close handler will reconnect
      }
    }, PING_INTERVAL_MS);
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (!data || data === PONG) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    // A metadata-only DM nudge (docs/DMS.md): raise a desktop notification when this
    // machine's TUI isn't on that thread. Carries only the sender — never content.
    const notify = DmNotify.safeParse(value);
    if (notify.success) {
      notifyDmReceived(notify.data.from);
      return;
    }
    const parsed = PresenceSnapshot.safeParse(value);
    if (!parsed.success) return;
    writeCounts(parsed.data);
    // Cross-agent "expert available" surface (the §3B notification, agent-neutral):
    // fire a best-effort, non-blocking desktop notification when an expert first
    // becomes available. Carries no content (the snapshot has only counts) → §11.3-safe.
    // NOTE: `experts` is hardcoded 0 in the lobby today, so this is DORMANT until
    // expert presence is surfaced to this stream (a deferred, non-money edge change).
    if (crossedExpertAvailable(lastExperts, parsed.data.experts)) notifyExpertAvailable();
    lastExperts = parsed.data.experts;
  });

  const onDown = (): void => {
    if (settled) return;
    settled = true;
    if (pingTimer) clearInterval(pingTimer);
    scheduleReconnect(url, protocols);
  };
  ws.addEventListener("close", onDown);
  ws.addEventListener("error", onDown);
}

function scheduleReconnect(url: string, protocols?: string[]): void {
  reconnectAttempts += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  setTimeout(() => connect(url, protocols), delay);
}
