/**
 * The "wire" olive design system for the terminal TUI.
 *
 * One palette, four surfaces (see `docs/UI-EXPLORATION.md` "olive IRC look"). These
 * are truecolor hex values passed straight to Ink `<Text color=... backgroundColor=...>`;
 * Ink/chalk downsample hex → ANSI-256 → 16 by terminal capability and strip all color
 * when `NO_COLOR` is set, so no manual gating is needed here.
 *
 * This module lives inside `apps/cli` on purpose: the client is open-sourced via the
 * `publish:client` mirror (CLI + protocol only), so the TUI must never import the
 * edge's web theme tokens. The shared "one palette" is a values contract, not a shared
 * module — these hexes intentionally match the web surfaces byte-for-byte.
 */

/** Core "wire" olive palette (the committed dark default). */
export const C = {
  /** page / terminal background */
  bg: "#191b10",
  /** call stage background */
  bg2: "#15170e",
  /** cards, tiles, inputs, highlighted-row solid (no alpha in terminals) */
  panel: "#1f2214",
  /** selected-row/tab background — solid lavender block (the selection accent) */
  rowHighlight: "#c3b7f5",
  /** text on a selected row/tab (near-black, high contrast on the lavender block) */
  rowHighlightFg: "#191b10",
  /** hairline borders, row rules */
  line: "#33361f",
  /** sub-row rules (fainter) */
  lineSub: "#24271a",
  /** emphasized borders, button outlines */
  line2: "#4d5233",
  /** body text */
  fg: "#c9c5a0",
  /** secondary text, prose */
  fg2: "#a3a17f",
  /** headings, self-nick, bar text */
  fgBright: "#eae6c3",
  /** OTHER people's handles — chat authors, roster rows, expert/session names. One
   *  color for everyone: your own handle is the only one that differs (`fgBright`,
   *  bold), so "which one is me" reads instantly instead of getting lost in a
   *  per-nick rainbow. */
  nick: "#9fb08a",
  /** labels, inactive nav */
  muted: "#77754f",
  /** timestamps, hints, faintest text */
  muted2: "#63614a",
  /** lime — presence dots, ✓ verified, prompts, links, primary buttons (with bg text) */
  accent: "#cadb6a",
  /** amber — MONEY ONLY: rates, holds, charges, payouts, ⚡ summon. Never emphasis. */
  amber: "#d9a94e",
  /** end-call, destructive */
  danger: "#cf6b62",
  /** irssi status bar background (TUI top presence bar) */
  barBg: "#4d5233",
  /** darker bar background for the tab/window strip, so it reads as a separate line
   *  from the presence bar above it */
  barBg2: "#3a3e26",
  /** irssi status bar foreground */
  barFg: "#eae6c3",
  /** inverse background for the [end] chip in the status bar */
  endInverseBg: "#7a4438",
} as const;

/**
 * Approximate terminal cell width of a string, treating the emoji-presentation glyphs
 * the bars use (⚡ ⭐) as 2 cells. Used only to pad the olive status bars to full width
 * (Ink 5 has no Box background); over-estimating a hair is safe — it just leaves a
 * 1-cell gap rather than overflowing and wrapping the bar.
 */
export function cellWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += ch === "⚡" || ch === "⭐" ? 2 : 1;
  return n;
}

/**
 * Text color for a span inside a (possibly) selected row/tab. Selected rows render
 * as a solid lavender block (`C.rowHighlight`) with uniform near-black text, so a
 * selected span drops its normal semantic color (nick / lime / amber) for
 * `C.rowHighlightFg`. Each Ink `<Text>` sets its own `color`, so a parent color does
 * not cascade — every colored span must opt in via `selFg(active, …)`.
 */
export function selFg(active: boolean, base: string): string {
  return active ? C.rowHighlightFg : base;
}

/** Glyph vocabulary — all unicode text, no image assets. */
export const G = {
  online: "●",
  offline: "○",
  agentRunning: "◐",
  verified: "✓",
  topExpert: "⭐",
  summon: "⚡",
  rating: "★",
  cursor: "›",
  livePlay: "▶",
} as const;
