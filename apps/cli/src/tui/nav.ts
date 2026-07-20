/**
 * Pure keyboard-navigation reducer for the tabbed TUI (steps 1–2 of
 * docs/UI-EXPLORATION.md). Kept free of Ink and any client so it is unit-testable
 * on its own — the App component is a thin dispatcher over the {@link NavAction}s
 * this returns. Mouse (step 3) will route hit-tested clicks to the *same* actions.
 */

/** Top-level tabs, in cycle order (Tab / Shift+Tab move through these). Experts is
 *  live calls; Bounties is the async board — two distinct marketplace surfaces. */
export const TABS = ["lounge", "dms", "experts", "bounties", "calls", "me"] as const;
export type TabId = (typeof TABS)[number];

/** Human labels for the tab strip, in TABS order. Shared by the view and the
 *  hit-tester so click targets line up with what's drawn. */
export const TAB_LABELS: Record<TabId, string> = {
  lounge: "Lounge",
  dms: "DMs",
  experts: "Experts",
  bounties: "Bounties",
  calls: "Calls",
  me: "Me",
};

/** One cell of the irssi-style numbered window strip (design 2a). SINGLE source of
 *  truth for the strip: both the renderer (App.tsx) and the click hit-tester
 *  (hit-test.ts) build from this so their widths can never drift. The active window is
 *  bracketed `[3:experts]`; inactive ones ` 2:dms `; DMs appends an unread badge `(2!)`. */
export interface WindowCell {
  tab: TabId;
  /** Exact rendered text, including the surrounding brackets/spaces (width-significant). */
  text: string;
  active: boolean;
  unread: boolean;
}

export function windowStripCells(activeTab: TabId, dmUnread: number): WindowCell[] {
  return TABS.map((t, i) => {
    const active = t === activeTab;
    const unread = t === "dms" && dmUnread > 0;
    const badge = unread ? `(${dmUnread}!)` : "";
    const text = active ? `[${i + 1}:${t}${badge}]` : ` ${i + 1}:${t}${badge} `;
    return { tab: t, text, active, unread };
  });
}

/** The subset of Ink's key flags the reducer reads (all optional booleans). */
export interface KeyLike {
  tab?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** DMs sub-view (see DM-IMPROVEMENTS.md): the inbox list, an open thread, or the
 *  "new DM" composer. Drives which keys the DMs pane accepts. */
export type DmView = "inbox" | "thread" | "new";

export interface NavState {
  activeTab: TabId;
  /** Highlighted item index within the active tab (already clamped by the caller). */
  selection: number;
  /** Number of selectable items in the active tab (0 = nothing selectable). */
  itemCount: number;
  /** Current chat draft (only meaningful in the Lounge). */
  draft: string;
  /** True while a login code is pending — freezes tab switching so the input can
   *  capture the pasted code without a stray Tab stealing focus. */
  locked: boolean;
  /** Which DMs sub-view is showing (only meaningful when activeTab === "dms").
   *  Defaults to "inbox" when unset. */
  dmView?: DmView;
  /** True when the `/` command autocomplete menu is open (lounge, draft is a bare
   *  command prefix). While open it captures ↑/↓/Tab/Enter/Esc for the menu. */
  paletteOpen?: boolean;
}

export type NavAction =
  | { type: "switch-tab"; tab: TabId }
  | { type: "move-selection"; selection: number }
  | { type: "activate" }
  | { type: "submit"; line: string }
  | { type: "edit-draft"; draft: string }
  | { type: "back" }
  // command-palette actions (the App owns the filtered list + selection index)
  | { type: "palette-move"; delta: number }
  | { type: "palette-accept" }
  | { type: "palette-close" }
  | { type: "none" };

function cycle(current: TabId, dir: 1 | -1): TabId {
  const i = TABS.indexOf(current);
  const next = (i + dir + TABS.length) % TABS.length;
  return TABS[next] as TabId;
}

/**
 * Map a single keypress to a navigation action. The caller applies the action to
 * React state and (for `activate`/`submit`) to the marketplace/lounge clients.
 *
 * Model:
 *  - Tab / Shift+Tab switch tabs (disabled while `locked`).
 *  - In the **Lounge**, keys drive the chat input: printable → edit-draft,
 *    Backspace → edit-draft, Enter → submit. Arrows are no-ops for now
 *    (keyboard scrollback is deferred to step 3, alongside wheel scroll).
 *  - In every **other** tab there is no text input: ↑/↓ move the selection,
 *    Enter activates it, and printable keys are **dropped** (never leak into the
 *    Lounge draft).
 */
export function reduceKey(state: NavState, input: string, key: KeyLike): NavAction {
  // The `/` command menu (lounge) captures navigation keys while it's open. Typing and
  // backspace still edit the draft — that re-filters the menu (and closes it once the
  // draft stops being a bare command prefix, e.g. after a space).
  if (state.paletteOpen) {
    if (key.upArrow) return { type: "palette-move", delta: -1 };
    if (key.downArrow) return { type: "palette-move", delta: 1 };
    if (key.tab || key.return) return { type: "palette-accept" };
    if (key.escape) return { type: "palette-close" };
    if (key.backspace || key.delete) return { type: "edit-draft", draft: state.draft.slice(0, -1) };
    if (input && !key.ctrl && !key.meta) return { type: "edit-draft", draft: state.draft + input };
    return { type: "none" };
  }

  if (key.tab) {
    if (state.locked) return { type: "none" };
    return { type: "switch-tab", tab: cycle(state.activeTab, key.shift ? -1 : 1) };
  }

  if (state.activeTab === "lounge") {
    if (key.return) return { type: "submit", line: state.draft };
    if (key.backspace || key.delete) return { type: "edit-draft", draft: state.draft.slice(0, -1) };
    if (input && !key.ctrl && !key.meta) return { type: "edit-draft", draft: state.draft + input };
    return { type: "none" };
  }

  // DMs has three sub-views (DM-IMPROVEMENTS.md):
  //  - inbox:  a selectable list [+ Send new DM, ...threads] — no composer. ↑/↓ move,
  //            Enter activates (index 0 = new DM, index ≥1 = open threads[index-1]).
  //            Typing is ignored so keystrokes never leak into a draft.
  //  - thread: the open conversation's composer. Typing edits the draft; Enter sends a
  //            non-empty draft; Esc goes back to the inbox.
  //  - new:    the "@username …" composer. Typing edits; Enter submits (App parses the
  //            handle + optional message); Esc goes back.
  if (state.activeTab === "dms") {
    const view = state.dmView ?? "inbox";
    if (view === "inbox") {
      if (key.upArrow)
        return { type: "move-selection", selection: Math.max(0, state.selection - 1) };
      if (key.downArrow) {
        const max = Math.max(0, state.itemCount - 1);
        return { type: "move-selection", selection: Math.min(max, state.selection + 1) };
      }
      if (key.return) return { type: "activate" };
      return { type: "none" };
    }
    // thread | new — a composer is focused.
    if (key.escape) return { type: "back" };
    if (key.return) {
      if (view === "new") return { type: "submit", line: state.draft };
      return state.draft.trim() ? { type: "submit", line: state.draft } : { type: "none" };
    }
    if (key.backspace || key.delete) return { type: "edit-draft", draft: state.draft.slice(0, -1) };
    if (input && !key.ctrl && !key.meta) return { type: "edit-draft", draft: state.draft + input };
    return { type: "none" };
  }

  // Non-Lounge tabs: selectable lists, no text entry.
  if (key.upArrow) return { type: "move-selection", selection: Math.max(0, state.selection - 1) };
  if (key.downArrow) {
    const max = Math.max(0, state.itemCount - 1);
    return { type: "move-selection", selection: Math.min(max, state.selection + 1) };
  }
  if (key.return) return { type: "activate" };
  return { type: "none" };
}
