import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PresenceCounts } from "@termchat/protocol";
import { ensureHome, onlineLinePath, termchatHome } from "./config.ts";

// Truecolor "wire" olive escapes (see apps/cli/src/tui/theme.ts — same hex values).
// Claude Code's status bar renders truecolor; NO_COLOR strips all of these.
const LIME = "\x1b[38;2;202;219;106m"; // --accent: presence dot, signal
const AMBER = "\x1b[38;2;217;169;78m"; // --amber: money only (⚡, rates, cost)
const FG = "\x1b[38;2;201;197;160m"; // --fg: counts
const MUTED = "\x1b[38;2;119;117;79m"; // --muted: separators, brand word
const RESET = "\x1b[0m";

/** Respect the NO_COLOR convention (present, any value → disable). PRD §16. */
export function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERMCHAT_NO_COLOR === "1") return false;
  return true;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** `MM:SS` for a connected-minutes elapsed count. */
function clock(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Render the ambient (idle) status line in the "wire" style: `● termchat 37 · ⚡4` —
 * the dot is lime (presence signal), `termchat` + the online count sit in fg/muted,
 * and the `⚡`+experts count is amber (money surface). Deliberately minimal: no room
 * or unread info (docs handoff). Experts is shown only when non-zero.
 */
export function renderLine(counts: PresenceCounts, color: boolean = useColor()): string {
  const online = fmt(counts.online);
  const experts = counts.experts > 0 ? counts.experts : 0;
  if (!color) {
    return experts > 0 ? `▄▀ termchat ${online} · ⚡${experts}` : `▄▀ termchat ${online}`;
  }
  // The ▄▀ brand mark (lime ▄ + amber ▀) replaces the presence dot — same two-tone
  // as the TUI top bar and the web logo's two squares.
  const mark = `${LIME}▄${AMBER}▀${RESET}`;
  const head = `${mark} ${MUTED}termchat${RESET} ${FG}${online}${RESET}`;
  return experts > 0 ? `${head} ${MUTED}·${RESET} ${AMBER}⚡${experts}${RESET}` : head;
}

/** Live in-call state the seeker's TUI records so the daemon can render the meter.
 *  Only the coarse peer handle + rate + start time — never prompt/topic/paths. */
export interface CallState {
  peer: string;
  /** Dollars per connected minute. */
  rate: number;
  /** Epoch ms when the session opened (the meter's zero). */
  startedAt: number;
}

/** How long the transient "accepted · call opening…" line shows before the meter. */
const ACCEPTED_MS = 3_000;

/**
 * Render the in-call status line from a recorded {@link CallState} and the current
 * time. For the first few seconds it reads `⚡ dana accepted · call opening in
 * browser…`; then it becomes the live meter `⚡ dana 03:12` — peer + elapsed time only.
 * We deliberately DON'T show a running dollar here: this surface can't see pause or the
 * audio-connect moment, so a cost would overstate the bill during a pause. The elapsed
 * clock is honest as "time since the call opened"; the browser call page + the Session
 * DO remain the authorities for money. Amber marks it as the summon/call surface.
 */
export function renderCallLine(
  call: CallState,
  now: number = Date.now(),
  color: boolean = useColor(),
): string {
  const elapsedMs = Math.max(0, now - call.startedAt);
  if (elapsedMs < ACCEPTED_MS) {
    const plain = `⚡ ${call.peer} accepted · call opening in browser…`;
    return color ? `${AMBER}${plain}${RESET}` : plain;
  }
  const secs = Math.floor(elapsedMs / 1000);
  if (!color) return `⚡ ${call.peer} ${clock(secs)}`;
  return `${AMBER}⚡ ${call.peer}${RESET} ${FG}${clock(secs)}${RESET}`;
}

/**
 * Atomically replace `~/.termchat/online.line` (write temp + rename on the same
 * filesystem) so the status-line `cat` never observes a partial write.
 */
export function writeOnlineLine(content: string): void {
  ensureHome();
  const dest = onlineLinePath();
  const tmp = `${dest}.tmp-${process.pid}`;
  const payload = content.endsWith("\n") ? content : `${content}\n`;
  writeFileSync(tmp, payload);
  renameSync(tmp, dest);
}

export function writeCounts(counts: PresenceCounts): void {
  writeOnlineLine(renderLine(counts));
}

/** Path to the daemon-read call-state file (`~/.termchat/call.json`). */
export function callStatePath(): string {
  return join(termchatHome(), "call.json");
}

/**
 * Record (or clear) the active call so the daemon can render the in-call meter across
 * processes: the TUI writes it on `session_start` and clears it on `session_end`; the
 * daemon polls it each second while a call is live. Atomic write; a `null` removes it.
 */
export function writeCallState(call: CallState | null): void {
  ensureHome();
  const dest = callStatePath();
  if (call === null) {
    if (existsSync(dest)) rmSync(dest);
    return;
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(call)}\n`);
  renameSync(tmp, dest);
}

/** Read the active call, or `null` when no call is live (or the file is unreadable). */
export function readCallState(): CallState | null {
  const path = callStatePath();
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CallState>;
    if (
      typeof value.peer === "string" &&
      typeof value.rate === "number" &&
      typeof value.startedAt === "number"
    ) {
      return { peer: value.peer, rate: value.rate, startedAt: value.startedAt };
    }
  } catch {
    // corrupt/partial → treat as no call
  }
  return null;
}
