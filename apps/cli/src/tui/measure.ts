/**
 * Text measurement that agrees with how Ink actually draws. The transcript windows to a
 * fixed number of terminal rows, so we must know how many rows a chat line will occupy
 * *after wrapping* — and count it the SAME way Ink does, or a wrapped line overflows the
 * fixed-height box and corrupts Ink's partial redraw (overlapping text, a fragmented
 * scroll hint). Ink wraps every `<Text wrap="wrap">` with exactly this `wrap-ansi` call
 * (see `ink/build/wrap-text.js`), so we reuse it rather than approximating with `ceil`.
 */
import wrapAnsi from "wrap-ansi";

/** Terminal rows a plain string occupies when soft-wrapped into `width` columns, counted
 *  with Ink's own `wrap-ansi` settings. `wrap-ansi` uses `string-width` internally, so
 *  wide/emoji characters are measured correctly. At least 1 (an empty line is a row). */
export function wrappedRows(text: string, width: number): number {
  const w = Math.max(1, Math.floor(width));
  if (text.length === 0) return 1;
  return wrapAnsi(text, w, { trim: false, hard: true }).split("\n").length;
}
