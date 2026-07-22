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
  leftArrow?: boolean;
  rightArrow?: boolean;
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
  /** Caret position within `draft`, 0…draft.length. Omit for "end of line" — every
   *  existing caller predates the caret and appends, so unset must mean append. */
  cursor?: number;
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
  /** Draft text changed. `cursor` is where the caret lands afterwards — always sent,
   *  so the App never has to re-derive it from the old and new strings. */
  | { type: "edit-draft"; draft: string; cursor: number }
  /** Caret moved without changing the text (←/→, Ctrl+A/Ctrl+E). */
  | { type: "move-cursor"; cursor: number }
  /** Walk the sent-message history (↑/↓ in a composer). The App owns the ring. */
  | { type: "history"; to: "prev" | "next" }
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

/** Caret index, defaulted to end-of-line and clamped into the draft. */
function caret(state: NavState): number {
  const end = state.draft.length;
  if (state.cursor === undefined) return end;
  return Math.max(0, Math.min(end, state.cursor));
}

/** Insert typed text at the caret (append when the caret is at the end). */
function insertAt(state: NavState, text: string): NavAction {
  const at = caret(state);
  return {
    type: "edit-draft",
    draft: state.draft.slice(0, at) + text + state.draft.slice(at),
    cursor: at + text.length,
  };
}

/** Backspace: remove the character BEFORE the caret. A no-op at the start of the
 *  line — returning an edit there would just re-render the same string. */
function backspaceAt(state: NavState): NavAction {
  const at = caret(state);
  if (at === 0) return { type: "none" };
  return {
    type: "edit-draft",
    draft: state.draft.slice(0, at - 1) + state.draft.slice(at),
    cursor: at - 1,
  };
}

/** ←/→ and the readline chords Ctrl+A / Ctrl+E. Returns null when the key isn't a
 *  caret move, so a composer branch can fall through to its other handling. */
function cursorMove(state: NavState, input: string, key: KeyLike): NavAction | null {
  const at = caret(state);
  if (key.leftArrow) return { type: "move-cursor", cursor: Math.max(0, at - 1) };
  if (key.rightArrow) return { type: "move-cursor", cursor: Math.min(state.draft.length, at + 1) };
  if (key.ctrl && input === "a") return { type: "move-cursor", cursor: 0 };
  if (key.ctrl && input === "e") return { type: "move-cursor", cursor: state.draft.length };
  return null;
}

/**
 * Split a draft for rendering a block cursor sitting ON the caret.
 *
 * A terminal caret covers the character it is on; the blink reveals that character
 * again. So the middle segment is the cursor glyph while `on`, and the covered
 * character while off — which keeps the line's width identical either way, so the
 * text after the caret never jitters as it blinks. At end-of-line there is no
 * character to cover, so it blinks against a space.
 */
export function caretSegments(
  draft: string,
  cursor: number,
  on: boolean,
): { before: string; at: string; after: string } {
  const at = Math.max(0, Math.min(draft.length, cursor));
  return {
    before: draft.slice(0, at),
    at: on ? "█" : (draft[at] ?? " "),
    after: draft.slice(at + 1),
  };
}

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
 *  - In the **Lounge**, keys drive the chat input: printable → edit-draft at the caret,
 *    Backspace → edit-draft, Enter → submit, ←/→ move the caret, ↑/↓ recall sent
 *    messages, PageUp/PageDown scroll the transcript. `Ctrl+U`
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
    if (key.backspace || key.delete) return backspaceAt(state);
    if (input && !key.ctrl && !key.meta) return insertAt(state, input);
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
    // The composer is always focused (type freely, like Claude Code). ←/→ walk the caret
    // and ↑/↓ walk what you've already sent — the shell bindings everyone already has in
    // their fingers. Scrollback therefore lives on PageUp/PageDown (and the mouse wheel);
    // Esc still snaps to the newest line.
    const move = cursorMove(state, input, key);
    if (move) return move;
    // While a login code is pending the draft IS that code — recalling history would
    // silently replace it, and the next Enter would submit the wrong value. Caret moves
    // are safe (they can't lose text), so only history is withheld.
    if (key.upArrow)
      return state.locked ? { type: "scroll", to: "up" } : { type: "history", to: "prev" };
    if (key.downArrow)
      return state.locked ? { type: "scroll", to: "down" } : { type: "history", to: "next" };
    if (key.pageUp) return { type: "scroll", to: "page-up" };
    if (key.pageDown) return { type: "scroll", to: "page-down" };
    if (key.escape) return { type: "scroll", to: "bottom" };
    if (key.backspace || key.delete) return backspaceAt(state);
    if (input && !key.ctrl && !key.meta) return insertAt(state, input);
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
    // Editing works the same in every composer: ←/→ move the caret, ↑/↓ recall what you
    // sent. Scrolling the open thread is PageUp/PageDown (Esc is taken for "back" here,
    // so there is no bottom-snap key — PageDown walks back to the newest line).
    const move = cursorMove(state, input, key);
    if (move) return move;
    if (key.upArrow) return { type: "history", to: "prev" };
    if (key.downArrow) return { type: "history", to: "next" };
    if (view === "thread") {
      if (key.pageUp) return { type: "scroll", to: "page-up" };
      if (key.pageDown) return { type: "scroll", to: "page-down" };
    }
    if (key.backspace || key.delete) return backspaceAt(state);
    if (input && !key.ctrl && !key.meta) return insertAt(state, input);
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
