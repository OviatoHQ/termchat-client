/**
 * Pure click-routing for the tabbed TUI (docs/UI-EXPLORATION.md, step 3). Given the
 * current view, produce the on-screen rectangles that are clickable and what each
 * one does; `hitTest` maps a mouse `(x,y)` to a target. Kept free of Ink/terminal so
 * the geometry is unit-testable — the App turns a returned target into the SAME
 * action the keyboard drives (switch tab / summon expert / run account action).
 *
 * Coordinates are 1-based cells, matching what the terminal reports for mouse events
 * and how the layout stacks: the olive title bar is row 1, the tab strip row 2, and
 * each tab's body starts at row 3. Every body line is exactly one row tall, so row
 * math is deterministic. These constants MUST track the render in App.tsx.
 */
import { type DmView, type TabId, windowStripCells } from "./nav.ts";

/** 1-based row of the window strip (title/status bar is row 1). */
export const TAB_ROW = 2;
/** 1-based first row of the active tab's body. */
export const BODY_TOP = 3;
/** Rows of body chrome before the Me tab's action list (header, subheader, spacer).
 *  Exported so render tests can pin it against MeBody's actual output. */
export const ME_LIST_OFFSET = 3;
/** Rows of body chrome before the Experts list (the "Experts" header). Exported so
 *  render tests can pin it against ExpertsBody's actual output. */
export const EXPERTS_LIST_OFFSET = 1;
/** Rows of body chrome before the Bounties list (the "Bounties" header). */
export const BOUNTIES_LIST_OFFSET = 1;
/** Rows of body chrome before the Calls session list (header, active-status line,
 *  subheader). */
export const CALLS_LIST_OFFSET = 3;
/** Rows of body chrome before the Lounge roster's first member: the `#ROOM · N` header.
 *  The roster is the one list that isn't full-width — it lives in the right sidebar, so
 *  its regions carry an x offset too (see {@link rosterRegions}). */
export const ROSTER_LIST_OFFSET = 1;
/** Rows of body chrome before the DMs inbox list. The inbox's FIRST body row is the
 *  "+ Send new DM" action (no header chrome), so this is 0 — pinned by the dms-body
 *  render test against DmsBody's actual output. */
export const DMS_INBOX_OFFSET = 0;

export type ClickTarget =
  | { kind: "tab"; tab: TabId }
  | { kind: "expert"; index: number }
  | { kind: "me-action"; index: number }
  | { kind: "bounty"; index: number }
  | { kind: "bounty-post" }
  | { kind: "session"; index: number }
  // DMs inbox row: index 0 = "+ Send new DM", index ≥1 = threads[index-1]. This
  // convention is shared with activate("dms", index) and the nav reducer — keep in sync.
  | { kind: "dm-row"; index: number }
  | { kind: "dm-back" }
  // A Lounge roster row: index into the FULL member list (already un-windowed here), so
  // the App can resolve it to a handle the same way Enter-on-the-highlight does.
  | { kind: "roster-row"; index: number }
  // A row of the open roster action menu (index into the items the App built).
  | { kind: "roster-menu"; index: number };

export interface Region {
  /** 1-based top-left cell. */
  x: number;
  y: number;
  w: number;
  h: number;
  target: ClickTarget;
}

export interface HitTestView {
  activeTab: TabId;
  /** Terminal width, for full-row click targets. */
  cols: number;
  /** Total unread DMs — the window strip appends a `(N!)` badge that widens the DMs
   *  cell, so hit-testing must know it to keep later cells aligned. */
  dmUnread: number;
  /** Which DMs sub-view is showing (only used when activeTab === "dms"). */
  dmView: DmView;
  /** Number of DM threads in the inbox (inbox rows = 1 "+ Send new DM" + this). */
  dmThreadCount: number;
  expertsCount: number;
  meCount: number;
  bountiesCount: number;
  sessionsCount: number;
  /** First item index of the active list tab's on-screen window (0 when the whole list
   *  fits). Long lists scroll to follow the selection, so a clicked row's y no longer
   *  equals its index — regions are emitted for the visible window and offset by this.
   *  Defaults to 0 (render everything) when omitted. */
  listStart?: number;
  /** How many rows of the active list are on screen (the window height). Omitted → the
   *  whole list is drawn. */
  listCount?: number;
  /** Lounge only: how many members the roster sidebar holds. 0 (or omitted) → the
   *  sidebar has no clickable rows. */
  rosterCount?: number;
  /** Width of the Lounge's roster sidebar, in cells. The App owns the column split
   *  (`sidebarWidth`), so it must pass the same number it renders with. */
  sidebarWidth?: number;
  /** First member index of the roster's on-screen window, and how many rows of it are
   *  drawn — the roster scrolls to follow its selection just like the list tabs. */
  rosterStart?: number;
  rosterVisible?: number;
  /** The open roster action modal's clickable item rows, in absolute cells. Undefined
   *  when no menu is open. The App owns the placement (Ink has no absolute positioning,
   *  so the box is laid out with margins) and hands the resulting numbers over rather
   *  than having this module re-derive them. */
  rosterMenu?: { top: number; left: number; width: number; count: number };
}

/** The visible [start, end) slice of a list of `total` rows, honouring an optional
 *  window on the view. `end` is exclusive and clamped to `total`. */
function listSlice(view: HitTestView, total: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(view.listStart ?? 0, total));
  const end = view.listCount == null ? total : Math.min(total, start + view.listCount);
  return { start, end };
}

/** The window strip's clickable cells. Built from the SAME `windowStripCells` the
 *  renderer draws, so the numbered `[3:experts]`/` 2:dms ` widths (including the DMs
 *  unread badge) always line up with what's on screen. */
export function tabRegions(activeTab: TabId, dmUnread: number): Region[] {
  const regions: Region[] = [];
  let x = 1;
  for (const cell of windowStripCells(activeTab, dmUnread)) {
    const w = cell.text.length;
    regions.push({ x, y: TAB_ROW, w, h: 1, target: { kind: "tab", tab: cell.tab } });
    x += w;
  }
  return regions;
}

/** Full-width row targets inside the active tab's body (empty for tabs without a
 *  selectable list — the Lounge's own targets live in {@link rosterRegions}, which is
 *  sidebar-shaped rather than full-width). */
export function bodyRegions(view: HitTestView): Region[] {
  const regions: Region[] = [];
  const rowFull = (y: number, target: ClickTarget): Region => ({
    x: 1,
    y,
    w: view.cols,
    h: 1,
    target,
  });
  // Every list tab scrolls the same way: draw only the on-screen window (`listSlice`),
  // placing item `start + j` at the j-th body row so a click resolves to the true index
  // even when the list is scrolled. `end - start` rows are emitted, never more than fit.
  if (view.activeTab === "experts") {
    const { start, end } = listSlice(view, view.expertsCount);
    for (let i = start; i < end; i++) {
      regions.push(
        rowFull(BODY_TOP + EXPERTS_LIST_OFFSET + (i - start), { kind: "expert", index: i }),
      );
    }
  } else if (view.activeTab === "me") {
    const { start, end } = listSlice(view, view.meCount);
    for (let i = start; i < end; i++) {
      regions.push(
        rowFull(BODY_TOP + ME_LIST_OFFSET + (i - start), { kind: "me-action", index: i }),
      );
    }
  } else if (view.activeTab === "bounties") {
    // The claimable bounties plus the trailing "Post a bounty" row form one selectable
    // list of `bountiesCount + 1` rows (post = index bountiesCount). Window over all of
    // them so a scrolled-to-bottom board still shows — and correctly routes — the post row.
    const { start, end } = listSlice(view, view.bountiesCount + 1);
    for (let i = start; i < end; i++) {
      const y = BODY_TOP + BOUNTIES_LIST_OFFSET + (i - start);
      regions.push(
        i < view.bountiesCount
          ? rowFull(y, { kind: "bounty", index: i })
          : rowFull(y, { kind: "bounty-post" }),
      );
    }
  } else if (view.activeTab === "calls") {
    // Each past session is a row you can select to review (server gates eligibility).
    const { start, end } = listSlice(view, view.sessionsCount);
    for (let i = start; i < end; i++) {
      regions.push(
        rowFull(BODY_TOP + CALLS_LIST_OFFSET + (i - start), { kind: "session", index: i }),
      );
    }
  } else if (view.activeTab === "dms") {
    if (view.dmView === "inbox") {
      // Row 0 = "+ Send new DM"; rows 1..n = the threads (index i → threads[i-1]).
      const { start, end } = listSlice(view, 1 + view.dmThreadCount);
      for (let i = start; i < end; i++) {
        regions.push(
          rowFull(BODY_TOP + DMS_INBOX_OFFSET + (i - start), { kind: "dm-row", index: i }),
        );
      }
    } else if (view.dmView === "thread") {
      // The "‹ see all DMs" back action is the first body row.
      regions.push(rowFull(BODY_TOP, { kind: "dm-back" }));
    }
    // "new" composer has no clickable body rows (Esc cancels).
  }
  return regions;
}

/** The Lounge roster sidebar's clickable rows. Unlike every other body target these are
 *  NOT full-width: the roster is the right-hand column, so a region starts at
 *  `cols − sidebarWidth + 1` (1-based) and is `sidebarWidth` wide — a click in the
 *  transcript at the same y must miss. Rows are offset by the drawn window's
 *  `rosterStart` so a scrolled roster still resolves to the true member index. */
export function rosterRegions(view: HitTestView): Region[] {
  const total = view.rosterCount ?? 0;
  const w = view.sidebarWidth ?? 0;
  if (view.activeTab !== "lounge" || total === 0 || w <= 0) return [];
  const x = Math.max(1, view.cols - w + 1);
  const start = Math.max(0, Math.min(view.rosterStart ?? 0, total));
  const end = view.rosterVisible == null ? total : Math.min(total, start + view.rosterVisible);
  const regions: Region[] = [];
  for (let i = start; i < end; i++) {
    regions.push({
      x,
      y: BODY_TOP + ROSTER_LIST_OFFSET + (i - start),
      w,
      h: 1,
      target: { kind: "roster-row", index: i },
    });
  }
  return regions;
}

/** The open roster action modal's item rows. The modal floats over the CHAT column, not
 *  the sidebar, so its rows come from the App-supplied box rather than roster geometry —
 *  a mouse user never has to switch to the keyboard mid-choice. */
export function rosterMenuRegions(view: HitTestView): Region[] {
  const menu = view.rosterMenu;
  if (view.activeTab !== "lounge" || !menu || menu.count <= 0) return [];
  return Array.from({ length: menu.count }, (_, i) => ({
    x: menu.left,
    y: menu.top + i,
    w: menu.width,
    h: 1,
    target: { kind: "roster-menu", index: i } as ClickTarget,
  }));
}

/** All clickable regions for the current view, in draw order. */
export function regionsForView(view: HitTestView): Region[] {
  return [
    ...tabRegions(view.activeTab, view.dmUnread),
    ...bodyRegions(view),
    ...rosterRegions(view),
    // Last, so the modal wins over anything it covers while it's open.
    ...rosterMenuRegions(view),
  ];
}

/** Find the target at `(x,y)`, if any. Later regions win (an inner control beats the
 *  row it sits on), though the current layout has no overlaps. */
export function hitTest(regions: Region[], x: number, y: number): ClickTarget | undefined {
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i];
    if (r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.target;
  }
  return undefined;
}
