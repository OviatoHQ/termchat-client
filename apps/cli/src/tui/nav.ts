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

/** One cell of the irssi-style window strip (design 2a). SINGLE source of truth for the
 *  strip: both the renderer (App.tsx) and the click hit-tester (hit-test.ts) build from
 *  this so their widths can never drift. Labels are uppercase and unnumbered — the 1–6
 *  `Alt+1`…`Alt+6` jump straight to a window (irssi's numbers, without the clutter —
 *  plain digits can't do it, they're chat text). The active window is
 *  bracketed `[EXPERTS]`; inactive ones ` DMS `; DMs appends an unread badge `(2!)`. */
export interface WindowCell {
  tab: TabId;
  /** Exact rendered text, including the surrounding brackets/spaces (width-significant). */
  text: string;
  active: boolean;
  unread: boolean;
}

export function windowStripCells(activeTab: TabId, dmUnread: number): WindowCell[] {
  return TABS.map((t) => {
    const active = t === activeTab;
    const unread = t === "dms" && dmUnread > 0;
    const badge = unread ? `(${dmUnread}!)` : "";
    const label = t.toUpperCase();
    const text = active ? `[${label}${badge}]` : ` ${label}${badge} `;
    return { tab: t, text, active, unread };
  });
}

/** The subset of Ink's key flags the reducer reads (all optional booleans). */
export interface KeyLike {
  tab?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** How a scroll key wants to move a transcript viewport. Resolved to an actual offset
 *  in the App (which knows the visible row count); see scroll.ts `ScrollTo`. */
export type ScrollTo = "up" | "down" | "page-up" | "page-down" | "bottom";

/** DMs sub-view (see DM-IMPROVEMENTS.md): the inbox list, an open thread, or the
 *  "new DM" composer. Drives which keys the DMs pane accepts. */
export type DmView = "inbox" | "thread" | "new";

/** Which Lounge pane has the keyboard: the always-on chat composer (default), or the
 *  roster sidebar's selection mode. Ctrl+U toggles; Esc leaves roster focus. */
export type LoungeFocus = "composer" | "roster";

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
  /** Where Lounge keys go. "composer" (the default) is today's behaviour — type
   *  freely, ↑/↓ scroll back. "roster" is the sidebar-selection mode Ctrl+U toggles:
   *  ↑/↓ walk the member list, Enter opens that member's action menu, Esc returns to
   *  the composer. Only meaningful when `activeTab === "lounge"`. */
  loungeFocus?: LoungeFocus;
  /** True while the selected roster member's action menu is open (DM / tag / call).
   *  It sits ON TOP of roster focus, so Esc unwinds one level at a time. */
  rosterMenuOpen?: boolean;
  /** True when the `@` mention menu is open (lounge, the word being typed starts with
   *  `@`). Unlike the `/` menu it does NOT take Enter — a mention sits mid-sentence, so
   *  Enter still sends the line and Tab is what completes. */
  mentionOpen?: boolean;
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
  // lounge roster focus (Ctrl+U) + the selected member's action menu. The App owns the
  // member list and which handle is selected; the reducer only says "move"/"open"/"run".
  | { type: "roster-focus"; focus: LoungeFocus }
  | { type: "roster-move"; delta: number }
  | { type: "roster-menu-open" }
  | { type: "roster-menu-move"; delta: number }
  | { type: "roster-menu-accept" }
  | { type: "roster-menu-close" }
  // `@` mention autocomplete (the App owns the filtered roster + selection index)
  | { type: "mention-move"; delta: number }
  | { type: "mention-accept" }
  | { type: "mention-close" }
  // scroll the active transcript (lounge log / open DM thread) without stealing typing
  | { type: "scroll"; to: ScrollTo }
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
 *    Backspace → edit-draft, Enter → submit, arrows scroll the transcript. `Ctrl+U`
 *    hands the keyboard to the roster sidebar instead (see {@link LoungeFocus}); from
 *    there Enter opens the selected member's action menu and Esc walks back out.
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

  // The roster action menu (DM / tag / call) is modal: while it's open it swallows every
  // key, including Tab, so a window switch can't strand it. Esc unwinds ONE level, back
  // to roster focus (a second Esc then returns to the composer).
  if (state.activeTab === "lounge" && state.rosterMenuOpen) {
    if (key.upArrow) return { type: "roster-menu-move", delta: -1 };
    if (key.downArrow) return { type: "roster-menu-move", delta: 1 };
    if (key.return) return { type: "roster-menu-accept" };
    if (key.escape) return { type: "roster-menu-close" };
    return { type: "none" };
  }

  // The `@` mention menu rides ALONGSIDE the composer instead of capturing it: ↑/↓ pick,
  // Tab completes, Esc dismisses — but typing, Backspace and Enter behave exactly as they
  // would with no menu open. A mention is part of a sentence, so stealing Enter would
  // make every "hey @bob" take two presses to send.
  if (state.activeTab === "lounge" && state.mentionOpen) {
    if (key.upArrow) return { type: "mention-move", delta: -1 };
    if (key.downArrow) return { type: "mention-move", delta: 1 };
    if (key.tab) return { type: "mention-accept" };
    if (key.escape) return { type: "mention-close" };
  }

  // Alt+1…Alt+6 jump straight to a window (irssi muscle memory). Alt, not a bare digit:
  // the Lounge composer is always live, so "1" has to stay a character you can type.
  if (key.meta && /^[1-6]$/.test(input)) {
    if (state.locked) return { type: "none" };
    const tab = TABS[Number(input) - 1];
    if (tab) return { type: "switch-tab", tab };
  }

  if (key.tab) {
    if (state.locked) return { type: "none" };
    return { type: "switch-tab", tab: cycle(state.activeTab, key.shift ? -1 : 1) };
  }

  // Roster focus (Ctrl+U): ↑/↓ walk the sidebar, Enter opens the selected member's menu,
  // Esc (or Ctrl+U again) hands the keyboard back to the composer. Printable keys are
  // DROPPED here rather than appended to the draft — typing blind into a composer you
  // can't see the cursor in is the failure mode this mode has to avoid.
  if (state.activeTab === "lounge" && state.loungeFocus === "roster") {
    if (key.ctrl && input === "u") return { type: "roster-focus", focus: "composer" };
    if (key.escape) return { type: "roster-focus", focus: "composer" };
    if (key.upArrow) return { type: "roster-move", delta: -1 };
    if (key.downArrow) return { type: "roster-move", delta: 1 };
    if (key.return) return { type: "roster-menu-open" };
    return { type: "none" };
  }

  if (state.activeTab === "lounge") {
    if (key.ctrl && input === "u") return { type: "roster-focus", focus: "roster" };
    if (key.return) return { type: "submit", line: state.draft };
    // The composer is always focused (type freely, like Claude Code); scrollback rides
    // the keys that carry no printable input, so nothing competes with typing. Esc snaps
    // back to the newest line.
    if (key.pageUp) return { type: "scroll", to: "page-up" };
    if (key.pageDown) return { type: "scroll", to: "page-down" };
    if (key.upArrow) return { type: "scroll", to: "up" };
    if (key.downArrow) return { type: "scroll", to: "down" };
    if (key.escape) return { type: "scroll", to: "bottom" };
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
    // Scroll the open thread's history (Esc is taken for "back", so no bottom-snap key
    // here — PageDown/↓ walk back to the newest line instead). The "new" composer has no
    // transcript, so its scroll keys are harmless no-ops the App ignores.
    if (view === "thread") {
      if (key.pageUp) return { type: "scroll", to: "page-up" };
      if (key.pageDown) return { type: "scroll", to: "page-down" };
      if (key.upArrow) return { type: "scroll", to: "up" };
      if (key.downArrow) return { type: "scroll", to: "down" };
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
