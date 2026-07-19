import { renameSync, writeFileSync } from "node:fs";
import type { PresenceCounts } from "@termchat/protocol";
import { ensureHome, onlineLinePath } from "./config.ts";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
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

/**
 * Render the ambient status-line string: `💬 chat ● 12 online - 4 expert`. The dot
 * stays green (presence signal); the counts are dim. Online is always shown; waiting
 * and experts only when non-zero (experts is always 0 in Phase 0).
 */
export function renderLine(counts: PresenceCounts, color: boolean = useColor()): string {
  const parts = [`${fmt(counts.online)} online`];
  if (counts.waiting > 0) parts.push(`${fmt(counts.waiting)} waiting`);
  if (counts.experts > 0) parts.push(`${fmt(counts.experts)} expert`);
  const text = parts.join(" - ");
  return color ? `💬 chat ${GREEN}●${RESET} ${DIM}${text}${RESET}` : `💬 chat ● ${text}`;
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
