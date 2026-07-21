/**
 * Pure scroll/windowing math for the TUI (docs/UI-EXPLORATION.md). Kept free of Ink
 * and React so it is unit-testable on its own — the App holds the small pieces of
 * scroll *state* and calls these to derive what to draw.
 *
 * Two shapes of scroll live here:
 *
 *  1. **Transcripts** (the lounge log, an open DM thread) scroll by an *offset from
 *     the bottom* measured in rows: 0 = pinned to the newest line (stick-to-bottom).
 *     Because the client caps these buffers to a ring (`lounge-client.ts` MAX_LINES),
 *     a busy room drops a line off the top for every line added — so tracking the
 *     scroll position as a mutable "lines from bottom" would silently drift by one row
 *     per message once the ring is full. We anchor on a stable line **id** instead and
 *     re-derive the offset each render; a line that rotates out of the ring snaps the
 *     view to the top of what remains.
 *
 *  2. **Selectable lists** (Experts/Bounties/Calls/Me/DM-inbox) window to the rows that
 *     fit while keeping the highlighted `sel` on screen (the command-palette pattern).
 */

/** Clamp a bottom-offset into `[0, max]` where `max` leaves at least one screen shown. */
export function clampOffset(offset: number, total: number, visible: number): number {
  const max = Math.max(0, total - Math.max(1, visible));
  return Math.min(Math.max(0, Math.floor(offset)), max);
}

export interface TailWindow<T> {
  /** The slice to draw, oldest→newest. */
  shown: T[];
  /** Items hidden above the viewport (older). */
  hiddenAbove: number;
  /** Items hidden below the viewport (newer) — equals the clamped offset. */
  hiddenBelow: number;
}

/** Window `items` to the last `visible` rows, scrolled up by `offset` rows from the
 *  bottom (0 = the newest rows). Offset is clamped so the window never runs off either end. */
export function windowTail<T>(items: T[], visible: number, offset: number): TailWindow<T> {
  const v = Math.max(1, visible);
  const clamped = clampOffset(offset, items.length, v);
  const end = items.length - clamped;
  const start = Math.max(0, end - v);
  return { shown: items.slice(start, end), hiddenAbove: start, hiddenBelow: clamped };
}

/**
 * Derive the bottom-offset for an id-anchored transcript.
 *  - `anchorId === null` → pinned to the bottom (offset 0).
 *  - anchor still present → offset that puts the anchored line on the bottom row.
 *  - anchor rotated out of the ring → snap to the top of what remains (max offset),
 *    keeping the user near the oldest still-available line rather than lurching.
 */
export function offsetForAnchor(ids: string[], anchorId: string | null, visible: number): number {
  if (anchorId === null) return 0;
  const idx = ids.indexOf(anchorId);
  if (idx === -1) return clampOffset(ids.length, ids.length, visible); // → max offset (top)
  return clampOffset(ids.length - 1 - idx, ids.length, visible);
}

/**
 * The anchor id to store after scrolling to `offset` — the id of the line that should
 * sit on the bottom visible row. Returns `null` when the scroll lands at the bottom
 * (stick-to-bottom), so new lines keep the view pinned.
 */
export function anchorForOffset(ids: string[], offset: number, visible: number): string | null {
  const clamped = clampOffset(offset, ids.length, visible);
  if (clamped === 0) return null;
  return ids[ids.length - 1 - clamped] ?? null;
}

/** One scroll step, expressed against the *current* anchor. `to` is the intent; the
 *  helper resolves it to a new offset (clamped) and returns the id to re-anchor on. */
export type ScrollTo = "up" | "down" | "page-up" | "page-down" | "top" | "bottom";

export function scrollAnchor(
  ids: string[],
  anchorId: string | null,
  visible: number,
  to: ScrollTo,
): string | null {
  const v = Math.max(1, visible);
  const cur = offsetForAnchor(ids, anchorId, v);
  const page = Math.max(1, v - 1);
  const max = Math.max(0, ids.length - v);
  let next = cur;
  switch (to) {
    case "up":
      next = cur + 1;
      break;
    case "down":
      next = cur - 1;
      break;
    case "page-up":
      next = cur + page;
      break;
    case "page-down":
      next = cur - page;
      break;
    case "top":
      next = max;
      break;
    case "bottom":
      next = 0;
      break;
  }
  return anchorForOffset(ids, next, v);
}

/** How many terminal rows a line of `cells` display columns occupies when soft-wrapped
 *  into a `colWidth`-wide column. At least 1 (an empty line still takes a row). */
export function cellsToRows(cells: number, colWidth: number): number {
  const w = Math.max(1, Math.floor(colWidth));
  return Math.max(1, Math.ceil(Math.max(0, cells) / w));
}

export interface RowWindow<T> {
  /** The slice to draw, oldest→newest. */
  shown: T[];
  /** Items entirely above the viewport. */
  hiddenAbove: number;
  /** Items entirely below the viewport (newer) — the clamped bottom offset in *items*. */
  hiddenBelow: number;
  /** The offset actually used (clamped so the window stays full down to the true top). */
  offset: number;
  /** The largest offset that still fills the viewport from the top. */
  maxOffset: number;
}

/**
 * Window `items` to the rows that fit, scrolled up by `offset` *items* from the newest.
 * Unlike {@link windowTail}, this accounts for **line wrapping**: each item can occupy
 * more than one terminal row (`rowsOf`), so a transcript of wrapped chat lines never
 * overflows its fixed-height box (which would corrupt Ink's partial redraw). Offset is
 * in items (an id anchor maps cleanly to it); the fit is measured in rows.
 */
export function windowByRows<T>(
  items: T[],
  visibleRows: number,
  offset: number,
  rowsOf: (item: T) => number,
): RowWindow<T> {
  const n = items.length;
  const vr = Math.max(1, Math.floor(visibleRows));
  if (n === 0) return { shown: [], hiddenAbove: 0, hiddenBelow: 0, offset: 0, maxOffset: 0 };
  // maxOffset: walking from the OLDEST item down, the first item at which a full screen of
  // rows has accumulated is the highest a full window's bottom row can sit — past it the
  // top would show empty space, so clamp there (keeps the view "full" until the true top).
  let cum = 0;
  let minBottom = n - 1;
  for (let i = 0; i < n; i++) {
    cum += Math.max(1, rowsOf(items[i] as T));
    if (cum >= vr) {
      minBottom = i;
      break;
    }
  }
  const maxOffset = Math.max(0, n - 1 - minBottom);
  const off = Math.min(Math.max(0, Math.floor(offset)), maxOffset);
  const bottom = n - 1 - off;
  // Fill upward from the bottom-visible item until the next item wouldn't fit (but always
  // show at least the bottom item, even if it alone is taller than the viewport).
  let used = 0;
  let start = bottom;
  for (let i = bottom; i >= 0; i--) {
    const c = Math.max(1, rowsOf(items[i] as T));
    if (i !== bottom && used + c > vr) break;
    used += c;
    start = i;
    if (used >= vr) break;
  }
  return {
    shown: items.slice(start, bottom + 1),
    hiddenAbove: start,
    hiddenBelow: off,
    offset: off,
    maxOffset,
  };
}

/** Step a row-windowed scroll: given the current (clamped) offset and the max, resolve a
 *  scroll intent to the next offset. Paging moves by a near-full screen of items. */
export function stepRowOffset(
  current: number,
  maxOffset: number,
  visibleRows: number,
  to: ScrollTo,
): number {
  const page = Math.max(1, Math.floor(visibleRows) - 1);
  let next = current;
  switch (to) {
    case "up":
      next = current + 1;
      break;
    case "down":
      next = current - 1;
      break;
    case "page-up":
      next = current + page;
      break;
    case "page-down":
      next = current - page;
      break;
    case "top":
      next = maxOffset;
      break;
    case "bottom":
      next = 0;
      break;
  }
  return Math.min(Math.max(0, next), Math.max(0, maxOffset));
}

/** The item offset (from the newest) that an id anchor points to, unclamped. `null` →
 *  pinned to the bottom (0); an id that rotated out of the ring → the very top. */
export function rawOffsetForAnchor(ids: string[], anchorId: string | null): number {
  if (anchorId === null) return 0;
  const idx = ids.indexOf(anchorId);
  if (idx === -1) return ids.length; // beyond maxOffset → clamped to the top by the window
  return ids.length - 1 - idx;
}

/** Window a selectable list of `total` rows to `visible`, keeping `sel` on screen with
 *  a little lead context (`pad` rows) — the command-palette windowing generalised.
 *  Returns the first visible index and how many rows to draw. */
export function listWindow(
  total: number,
  visible: number,
  sel: number,
  pad = 3,
): { start: number; count: number } {
  const v = Math.max(1, visible);
  if (total <= v) return { start: 0, count: total };
  const p = Math.min(Math.max(0, pad), v - 1);
  const start = Math.min(Math.max(0, sel - p), total - v);
  return { start, count: v };
}
