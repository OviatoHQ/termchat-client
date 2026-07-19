/**
 * Pure click-routing for the tabbed TUI (docs/UI-EXPLORATION.md, step 3). Given the
 * current view, produce the on-screen rectangles that are clickable and what each
 * one does; `hitTest` maps a mouse `(x,y)` to a target. Kept free of Ink/terminal so
 * the geometry is unit-testable — the App turns a returned target into the SAME
 * action the keyboard drives (switch tab / summon expert / run account action).
 *
 * Coordinates are 1-based cells, matching what the terminal reports for mouse events
 * and how the layout stacks: the title bar is row 1, the tab strip row 2, and each
 * tab's body starts at row 3. Every body line is exactly one row tall, so row math
 * is deterministic. These constants MUST track the render in App.tsx.
 */
import { TABS, TAB_LABELS, type TabId } from "./nav.ts";

/** 1-based row of the tab strip (title bar is row 1). */
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

export type ClickTarget =
  | { kind: "tab"; tab: TabId }
  | { kind: "expert"; index: number }
  | { kind: "me-action"; index: number }
  | { kind: "bounty"; index: number }
  | { kind: "bounty-post" }
  | { kind: "session"; index: number };

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
  expertsCount: number;
  meCount: number;
  bountiesCount: number;
  sessionsCount: number;
}

/** The tab strip's clickable cells. Widths are independent of which tab is active
 *  (active `[Label] ` and inactive ` Label  ` are the same width), so this is stable. */
export function tabRegions(): Region[] {
  const regions: Region[] = [];
  let x = 1;
  for (const tab of TABS) {
    const w = TAB_LABELS[tab].length + 3;
    regions.push({ x, y: TAB_ROW, w, h: 1, target: { kind: "tab", tab } });
    x += w;
  }
  return regions;
}

/** Full-width row targets inside the active tab's body (empty for tabs without a
 *  selectable list — Lounge roster/room clicks land with the DM/profile work). */
export function bodyRegions(view: HitTestView): Region[] {
  const regions: Region[] = [];
  const rowFull = (y: number, target: ClickTarget): Region => ({
    x: 1,
    y,
    w: view.cols,
    h: 1,
    target,
  });
  if (view.activeTab === "experts") {
    for (let i = 0; i < view.expertsCount; i++) {
      regions.push(rowFull(BODY_TOP + EXPERTS_LIST_OFFSET + i, { kind: "expert", index: i }));
    }
  } else if (view.activeTab === "me") {
    for (let i = 0; i < view.meCount; i++) {
      regions.push(rowFull(BODY_TOP + ME_LIST_OFFSET + i, { kind: "me-action", index: i }));
    }
  } else if (view.activeTab === "bounties") {
    // Each open bounty is a claimable row; a "Post a bounty" row sits right after.
    for (let i = 0; i < view.bountiesCount; i++) {
      regions.push(rowFull(BODY_TOP + BOUNTIES_LIST_OFFSET + i, { kind: "bounty", index: i }));
    }
    regions.push(
      rowFull(BODY_TOP + BOUNTIES_LIST_OFFSET + view.bountiesCount, { kind: "bounty-post" }),
    );
  } else if (view.activeTab === "calls") {
    // Each past session is a row you can select to review (server gates eligibility).
    for (let i = 0; i < view.sessionsCount; i++) {
      regions.push(rowFull(BODY_TOP + CALLS_LIST_OFFSET + i, { kind: "session", index: i }));
    }
  }
  return regions;
}

/** All clickable regions for the current view, in draw order. */
export function regionsForView(view: HitTestView): Region[] {
  return [...tabRegions(), ...bodyRegions(view)];
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
