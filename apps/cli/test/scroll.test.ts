import { expect, test } from "bun:test";
import {
  anchorForOffset,
  cellsToRows,
  clampOffset,
  listWindow,
  offsetForAnchor,
  rawOffsetForAnchor,
  scrollAnchor,
  stepRowOffset,
  windowByRows,
  windowTail,
} from "../src/tui/scroll.ts";

const ids = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => String(from + i));

test("windowTail: offset 0 shows the newest `visible` items (stick-to-bottom)", () => {
  const items = [1, 2, 3, 4, 5];
  const w = windowTail(items, 3, 0);
  expect(w.shown).toEqual([3, 4, 5]);
  expect(w.hiddenAbove).toBe(2);
  expect(w.hiddenBelow).toBe(0);
});

test("windowTail: a positive offset scrolls up, keeping the window full", () => {
  const items = [1, 2, 3, 4, 5];
  const w = windowTail(items, 3, 2);
  expect(w.shown).toEqual([1, 2, 3]);
  expect(w.hiddenAbove).toBe(0);
  expect(w.hiddenBelow).toBe(2);
});

test("windowTail: offset clamps so the window never runs off the top", () => {
  const items = [1, 2, 3, 4, 5];
  expect(windowTail(items, 3, 99).shown).toEqual([1, 2, 3]); // max offset = 2
  expect(windowTail(items, 3, 99).hiddenBelow).toBe(2);
});

test("windowTail: fewer items than the viewport shows them all", () => {
  expect(windowTail([1, 2], 5, 0).shown).toEqual([1, 2]);
  expect(windowTail([1, 2], 5, 3).shown).toEqual([1, 2]); // offset clamps to 0
});

test("clampOffset: bounded to [0, total - visible]", () => {
  expect(clampOffset(-4, 10, 3)).toBe(0);
  expect(clampOffset(99, 10, 3)).toBe(7);
  expect(clampOffset(2, 10, 3)).toBe(2);
});

test("offsetForAnchor: null anchor pins to the bottom (0)", () => {
  expect(offsetForAnchor(ids(10), null, 4)).toBe(0);
});

test("offsetForAnchor: an anchored line lands on the bottom visible row", () => {
  // Anchor "7" (index 7) of 10 lines → 2 newer lines below it → offset 2.
  expect(offsetForAnchor(ids(10), "7", 4)).toBe(2);
  // The window whose bottom row is the anchor:
  expect(windowTail(ids(10), 4, 2).shown).toEqual(["4", "5", "6", "7"]);
});

test("offsetForAnchor: an anchor that rotated out of the ring snaps to the top", () => {
  // The anchored id is no longer present → show the oldest still-available lines.
  const off = offsetForAnchor(ids(10), "does-not-exist", 4);
  expect(off).toBe(6); // max offset = 10 - 4
  expect(windowTail(ids(10), 4, off).shown).toEqual(["0", "1", "2", "3"]);
});

// The bug class the id-anchoring exists to prevent: on a FULL ring, every new message
// drops one line off the top and adds one at the bottom, so the array length never
// changes. A row-count offset would silently slide forward one line per message; an
// id anchor keeps the exact same lines on screen across the rotation.
test("anchor holds the view still across a full-ring rotation (no drift)", () => {
  const visible = 4;
  // A full ring of 20, ids 0..19. User scrolled so the bottom row is line "15".
  const before = ids(20, 0);
  const anchor = "15";
  expect(windowTail(before, visible, offsetForAnchor(before, anchor, visible)).shown).toEqual([
    "12",
    "13",
    "14",
    "15",
  ]);
  // Three new messages arrive on the full ring: "0","1","2" rotate off the top and
  // "20","21","22" join at the bottom — the array length is unchanged (the bug trap).
  const after = ids(20, 3); // ids 3..22, same length
  // The anchor id "15" is still present → the SAME four lines stay on screen. A row-count
  // offset would have slid the window forward by 3 here; the id anchor does not drift.
  expect(windowTail(after, visible, offsetForAnchor(after, anchor, visible)).shown).toEqual([
    "12",
    "13",
    "14",
    "15",
  ]);
});

test("anchorForOffset: offset 0 → null (re-pins to bottom for new messages)", () => {
  expect(anchorForOffset(ids(10), 0, 4)).toBeNull();
  expect(anchorForOffset(ids(10), 2, 4)).toBe("7"); // bottom row of that window
});

test("scrollAnchor: up/down move one line; bottom re-pins; clamps at the top", () => {
  const list = ids(10);
  // From the bottom (null), one line up anchors the second-newest as the bottom row.
  const up1 = scrollAnchor(list, null, 4, "up");
  expect(up1).toBe("8");
  // Down again returns to the bottom (null).
  expect(scrollAnchor(list, up1, 4, "down")).toBeNull();
  // Page-up moves by (visible - 1) = 3 rows.
  expect(scrollAnchor(list, null, 4, "page-up")).toBe("6");
  // Can't scroll above the top: bottom row settles at the oldest window's last line.
  expect(scrollAnchor(list, null, 4, "up") && scrollAnchor(list, "0", 4, "up")).toBe("3");
  // Bottom always re-pins.
  expect(scrollAnchor(list, "3", 4, "bottom")).toBeNull();
});

test("listWindow: short lists render whole; long lists keep the selection on screen", () => {
  expect(listWindow(4, 8, 2)).toEqual({ start: 0, count: 4 });
  // 20 items, 8 rows, sel near the end → window ends at the selection.
  const w = listWindow(20, 8, 18);
  expect(w).toEqual({ start: 12, count: 8 });
  expect(18).toBeGreaterThanOrEqual(w.start);
  expect(18).toBeLessThan(w.start + w.count);
  // sel in the middle keeps `pad` lead rows of context.
  const mid = listWindow(20, 8, 10);
  expect(mid.start).toBe(7); // sel - pad(3)
  expect(10).toBeLessThan(mid.start + mid.count);
});

// ---- wrap-aware windowing (each item may occupy >1 terminal row) ----

test("cellsToRows: ceil of cells / width, at least 1", () => {
  expect(cellsToRows(0, 10)).toBe(1);
  expect(cellsToRows(10, 10)).toBe(1);
  expect(cellsToRows(11, 10)).toBe(2);
  expect(cellsToRows(25, 10)).toBe(3);
});

// The core fix: a transcript of tall (wrapping) items must NEVER render more rows than
// the viewport — that overflow is what corrupted the redraw. Count rows, not items.
test("windowByRows never exceeds the row budget, even with multi-row items", () => {
  // 20 items, each 2 rows tall, viewport = 6 rows → at most 3 items (6 rows), not 6 items.
  const items = Array.from({ length: 20 }, (_, i) => i);
  const w = windowByRows(items, 6, 0, () => 2);
  const rows = w.shown.length * 2;
  expect(rows).toBeLessThanOrEqual(6);
  expect(w.shown).toEqual([17, 18, 19]); // the newest that fit
  expect(w.hiddenAbove).toBe(17);
});

test("windowByRows: mixed heights fill from the bottom without overflowing", () => {
  // rows per item: [1,3,1,1,2,1] ; viewport 4 rows, pinned to bottom.
  const heights = [1, 3, 1, 1, 2, 1];
  const items = heights.map((_, i) => i);
  const w = windowByRows(items, 4, 0, (i) => heights[i] ?? 1);
  // From the end: item5(1)+item4(2)+item3(1)=4 rows; item2 would make 5 → excluded.
  expect(w.shown).toEqual([3, 4, 5]);
});

test("windowByRows: an item taller than the viewport is still shown (never blank)", () => {
  const w = windowByRows([0, 1, 2], 2, 0, () => 5);
  expect(w.shown).toEqual([2]); // the bottom item alone, even though it's 5 rows
});

test("windowByRows: offset scrolls up in items; maxOffset keeps the window full", () => {
  const items = Array.from({ length: 10 }, (_, i) => i); // all 1-row
  const w = windowByRows(items, 4, 2, () => 1);
  expect(w.shown).toEqual([4, 5, 6, 7]);
  expect(w.hiddenBelow).toBe(2);
  // maxOffset for 10 one-row items in a 4-row viewport is 6 (top window = items 0..3).
  expect(w.maxOffset).toBe(6);
  expect(windowByRows(items, 4, 99, () => 1).shown).toEqual([0, 1, 2, 3]); // clamps to top
});

test("stepRowOffset: line/page/bottom moves, clamped to [0, maxOffset]", () => {
  expect(stepRowOffset(0, 6, 4, "up")).toBe(1);
  expect(stepRowOffset(3, 6, 4, "down")).toBe(2);
  expect(stepRowOffset(0, 6, 4, "page-up")).toBe(3); // page = visibleRows - 1
  expect(stepRowOffset(6, 6, 4, "page-up")).toBe(6); // clamped at maxOffset
  expect(stepRowOffset(2, 6, 4, "bottom")).toBe(0);
  expect(stepRowOffset(0, 6, 4, "down")).toBe(0); // can't go below the bottom
});

test("rawOffsetForAnchor: null → 0, present → distance from bottom, missing → past top", () => {
  expect(rawOffsetForAnchor(ids(10), null)).toBe(0);
  expect(rawOffsetForAnchor(ids(10), "7")).toBe(2);
  expect(rawOffsetForAnchor(ids(10), "gone")).toBe(10); // beyond maxOffset → clamps to top
});
