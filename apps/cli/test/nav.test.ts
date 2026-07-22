import { expect, test } from "bun:test";
import { type NavState, caretSegments, reduceKey } from "../src/tui/nav.ts";

const base: NavState = {
  activeTab: "lounge",
  selection: 0,
  itemCount: 0,
  draft: "",
  locked: false,
};

test("Tab cycles forward through the tabs; Shift+Tab cycles back", () => {
  expect(reduceKey(base, "", { tab: true })).toEqual({ type: "switch-tab", tab: "dms" });
  expect(reduceKey({ ...base, activeTab: "me" }, "", { tab: true })).toEqual({
    type: "switch-tab",
    tab: "lounge",
  });
  expect(reduceKey(base, "", { tab: true, shift: true })).toEqual({
    type: "switch-tab",
    tab: "me", // wraps backward from lounge to the last tab
  });
});

test("Tab is frozen while a login code is pending (locked)", () => {
  expect(reduceKey({ ...base, locked: true }, "", { tab: true })).toEqual({ type: "none" });
});

test("Lounge: printable keys, Backspace, and Enter drive the chat draft", () => {
  expect(reduceKey({ ...base, draft: "hi" }, "!", {})).toEqual({
    type: "edit-draft",
    draft: "hi!",
    cursor: 3,
  });
  expect(reduceKey({ ...base, draft: "hi" }, "", { backspace: true })).toEqual({
    type: "edit-draft",
    draft: "h",
    cursor: 1,
  });
  expect(reduceKey({ ...base, draft: "hello" }, "", { return: true })).toEqual({
    type: "submit",
    line: "hello",
  });
});

test("Lounge: Ctrl/Meta-modified keys don't append to the draft", () => {
  expect(reduceKey({ ...base, draft: "x" }, "c", { ctrl: true })).toEqual({ type: "none" });
});

test("Non-Lounge tabs drop printable keys (never leak into the Lounge draft)", () => {
  const experts = { ...base, activeTab: "experts" as const, itemCount: 3, draft: "keep-me" };
  expect(reduceKey(experts, "z", {})).toEqual({ type: "none" });
  expect(reduceKey(experts, "", { backspace: true })).toEqual({ type: "none" });
});

test("Non-Lounge tabs: arrows move selection within [0, itemCount-1]", () => {
  const experts = { ...base, activeTab: "experts" as const, itemCount: 3, selection: 1 };
  expect(reduceKey(experts, "", { downArrow: true })).toEqual({
    type: "move-selection",
    selection: 2,
  });
  expect(reduceKey({ ...experts, selection: 2 }, "", { downArrow: true })).toEqual({
    type: "move-selection",
    selection: 2, // clamped at the last item
  });
  expect(reduceKey({ ...experts, selection: 0 }, "", { upArrow: true })).toEqual({
    type: "move-selection",
    selection: 0, // clamped at the first item
  });
});

test("Non-Lounge tabs: Enter activates the current selection", () => {
  const me = { ...base, activeTab: "me" as const, itemCount: 4, selection: 2 };
  expect(reduceKey(me, "", { return: true })).toEqual({ type: "activate" });
});

test("Empty-list tab: Down stays at 0", () => {
  const calls = { ...base, activeTab: "calls" as const, itemCount: 0, selection: 0 };
  expect(reduceKey(calls, "", { downArrow: true })).toEqual({
    type: "move-selection",
    selection: 0,
  });
});

// DMs inbox: a selectable list, index 0 = "+ Send new DM", index ≥1 = threads[index-1].
// itemCount = 1 + threads.length (here: 1 + 2 threads = 3). No composer on the inbox.
test("DMs inbox: arrows move the selection; typing is ignored; Enter activates", () => {
  const inbox = {
    ...base,
    activeTab: "dms" as const,
    dmView: "inbox" as const,
    itemCount: 3,
    selection: 1,
  };
  expect(reduceKey(inbox, "", { downArrow: true })).toEqual({
    type: "move-selection",
    selection: 2,
  });
  expect(reduceKey(inbox, "", { upArrow: true })).toEqual({ type: "move-selection", selection: 0 });
  expect(reduceKey(inbox, "h", {})).toEqual({ type: "none" }); // no draft on the inbox
  expect(reduceKey(inbox, "", { return: true })).toEqual({ type: "activate" });
});

test("DMs inbox selection clamps at both ends", () => {
  const inbox = { ...base, activeTab: "dms" as const, dmView: "inbox" as const, itemCount: 3 };
  expect(reduceKey({ ...inbox, selection: 0 }, "", { upArrow: true })).toEqual({
    type: "move-selection",
    selection: 0,
  });
  expect(reduceKey({ ...inbox, selection: 2 }, "", { downArrow: true })).toEqual({
    type: "move-selection",
    selection: 2,
  });
});

test("DMs thread: typing edits the reply; Enter sends non-empty; empty Enter no-ops; Esc goes back", () => {
  const thread = { ...base, activeTab: "dms" as const, dmView: "thread" as const, itemCount: 0 };
  expect(reduceKey(thread, "h", {})).toEqual({ type: "edit-draft", draft: "h", cursor: 1 });
  expect(reduceKey({ ...thread, draft: "hey" }, "", { return: true })).toEqual({
    type: "submit",
    line: "hey",
  });
  expect(reduceKey(thread, "", { return: true })).toEqual({ type: "none" }); // don't send empty
  expect(reduceKey(thread, "", { escape: true })).toEqual({ type: "back" });
});

test("command palette: open menu captures arrows/Tab/Enter/Esc; typing re-filters", () => {
  const pal = { ...base, activeTab: "lounge" as const, draft: "/ca", paletteOpen: true };
  expect(reduceKey(pal, "", { downArrow: true })).toEqual({ type: "palette-move", delta: 1 });
  expect(reduceKey(pal, "", { upArrow: true })).toEqual({ type: "palette-move", delta: -1 });
  expect(reduceKey(pal, "", { tab: true })).toEqual({ type: "palette-accept" }); // Tab accepts, not switch-tab
  expect(reduceKey(pal, "", { return: true })).toEqual({ type: "palette-accept" });
  expect(reduceKey(pal, "", { escape: true })).toEqual({ type: "palette-close" });
  expect(reduceKey(pal, "l", {})).toEqual({ type: "edit-draft", draft: "/cal", cursor: 4 }); // keeps filtering
  expect(reduceKey(pal, "", { backspace: true })).toEqual({
    type: "edit-draft",
    draft: "/c",
    cursor: 2,
  });
});

test("DMs new-DM composer: typing edits; Enter submits the handle line; Esc goes back", () => {
  const compose = {
    ...base,
    activeTab: "dms" as const,
    dmView: "new" as const,
    itemCount: 0,
    draft: "@chef",
  };
  expect(reduceKey(compose, "x", {})).toEqual({ type: "edit-draft", draft: "@chefx", cursor: 6 });
  expect(reduceKey(compose, "", { return: true })).toEqual({ type: "submit", line: "@chef" });
  expect(reduceKey(compose, "", { escape: true })).toEqual({ type: "back" });
});

test("Lounge: scroll keys move the transcript without disturbing the draft", () => {
  const lounge = { ...base, draft: "half-typed" };
  // Page keys scroll; the composer is untouched (draft never changes). ↑/↓ are history
  // recall now, so scrolling lives on PageUp/PageDown and the mouse wheel.
  expect(reduceKey(lounge, "", { upArrow: true })).toEqual({ type: "history", to: "prev" });
  expect(reduceKey(lounge, "", { downArrow: true })).toEqual({ type: "history", to: "next" });
  expect(reduceKey(lounge, "", { pageUp: true })).toEqual({ type: "scroll", to: "page-up" });
  expect(reduceKey(lounge, "", { pageDown: true })).toEqual({ type: "scroll", to: "page-down" });
  // Esc snaps back to the newest line (only meaningful when scrolled up).
  expect(reduceKey(lounge, "", { escape: true })).toEqual({ type: "scroll", to: "bottom" });
  // …and printable keys still type, so scrolling never blocks the composer.
  expect(reduceKey(lounge, "!", {})).toEqual({
    type: "edit-draft",
    draft: "half-typed!",
    cursor: 11,
  });
});

test("DM thread: scroll keys walk the history; Esc stays 'back', not a scroll", () => {
  const thread = { ...base, activeTab: "dms" as const, dmView: "thread" as const, draft: "hi" };
  expect(reduceKey(thread, "", { pageUp: true })).toEqual({ type: "scroll", to: "page-up" });
  expect(reduceKey(thread, "", { upArrow: true })).toEqual({ type: "history", to: "prev" });
  // Esc is reserved for leaving the thread (no bottom-snap key here).
  expect(reduceKey(thread, "", { escape: true })).toEqual({ type: "back" });
  // Typing still edits the message being composed.
  expect(reduceKey(thread, "!", {})).toEqual({ type: "edit-draft", draft: "hi!", cursor: 3 });
});

test("DM inbox: arrows move the selection, not the scroll (it's a list, not a transcript)", () => {
  const inbox = {
    ...base,
    activeTab: "dms" as const,
    dmView: "inbox" as const,
    itemCount: 3,
    selection: 1,
  };
  expect(reduceKey(inbox, "", { downArrow: true })).toEqual({
    type: "move-selection",
    selection: 2,
  });
});

// ---- lounge roster focus (Ctrl+U) + the member action menu ----

const roster: NavState = { ...base, loungeFocus: "roster" };

test("Ctrl+U toggles the keyboard between the composer and the roster", () => {
  expect(reduceKey({ ...base, draft: "half-typed" }, "u", { ctrl: true })).toEqual({
    type: "roster-focus",
    focus: "roster",
  });
  expect(reduceKey(roster, "u", { ctrl: true })).toEqual({
    type: "roster-focus",
    focus: "composer",
  });
  // Ctrl+U outside the Lounge is not a roster key (those tabs are plain lists).
  expect(reduceKey({ ...base, activeTab: "experts" }, "u", { ctrl: true })).toEqual({
    type: "none",
  });
});

test("roster focus: arrows move the highlight, Enter opens the menu, Esc leaves", () => {
  expect(reduceKey(roster, "", { upArrow: true })).toEqual({ type: "roster-move", delta: -1 });
  expect(reduceKey(roster, "", { downArrow: true })).toEqual({ type: "roster-move", delta: 1 });
  expect(reduceKey(roster, "", { return: true })).toEqual({ type: "roster-menu-open" });
  expect(reduceKey(roster, "", { escape: true })).toEqual({
    type: "roster-focus",
    focus: "composer",
  });
});

test("roster focus drops printable keys (they must never leak into the chat draft)", () => {
  const typed = { ...roster, draft: "half-typed" };
  expect(reduceKey(typed, "x", {})).toEqual({ type: "none" });
  expect(reduceKey(typed, "", { backspace: true })).toEqual({ type: "none" });
});

test("the roster menu is modal: it captures arrows/Enter/Esc and even Tab", () => {
  const menu: NavState = { ...roster, rosterMenuOpen: true };
  expect(reduceKey(menu, "", { upArrow: true })).toEqual({ type: "roster-menu-move", delta: -1 });
  expect(reduceKey(menu, "", { downArrow: true })).toEqual({ type: "roster-menu-move", delta: 1 });
  expect(reduceKey(menu, "", { return: true })).toEqual({ type: "roster-menu-accept" });
  expect(reduceKey(menu, "", { tab: true })).toEqual({ type: "none" }); // no window switch
  expect(reduceKey(menu, "x", {})).toEqual({ type: "none" });
});

test("Esc unwinds ONE level at a time: menu → roster focus → composer", () => {
  const menu: NavState = { ...roster, rosterMenuOpen: true };
  expect(reduceKey(menu, "", { escape: true })).toEqual({ type: "roster-menu-close" });
  expect(reduceKey(roster, "", { escape: true })).toEqual({
    type: "roster-focus",
    focus: "composer",
  });
  // Back at the composer, Esc means what it always did — snap to the newest line.
  expect(reduceKey(base, "", { escape: true })).toEqual({ type: "scroll", to: "bottom" });
});

test("Tab still switches windows while the roster (not its menu) has focus", () => {
  expect(reduceKey(roster, "", { tab: true })).toEqual({ type: "switch-tab", tab: "dms" });
});

// ---- `@` mention autocomplete (rides alongside the composer; Tab completes) ----

const mention: NavState = { ...base, draft: "hey @b", mentionOpen: true };

test("the mention menu takes ↑/↓, Tab and Esc — but never Enter", () => {
  expect(reduceKey(mention, "", { upArrow: true })).toEqual({ type: "mention-move", delta: -1 });
  expect(reduceKey(mention, "", { downArrow: true })).toEqual({ type: "mention-move", delta: 1 });
  expect(reduceKey(mention, "", { tab: true })).toEqual({ type: "mention-accept" });
  expect(reduceKey(mention, "", { escape: true })).toEqual({ type: "mention-close" });
  // Enter still SENDS: a mention sits mid-sentence, so stealing Enter would make every
  // "hey @bob" take two presses.
  expect(reduceKey(mention, "", { return: true })).toEqual({ type: "submit", line: "hey @b" });
});

test("typing and backspace keep editing the draft while the mention menu is open", () => {
  expect(reduceKey(mention, "o", {})).toEqual({ type: "edit-draft", draft: "hey @bo", cursor: 7 });
  expect(reduceKey(mention, "", { backspace: true })).toEqual({
    type: "edit-draft",
    draft: "hey @",
    cursor: 5,
  });
});

test("Tab only completes a mention in the Lounge — elsewhere it still switches windows", () => {
  expect(reduceKey({ ...mention, activeTab: "experts" }, "", { tab: true })).toEqual({
    type: "switch-tab",
    tab: "bounties",
  });
});

test("Alt+1…Alt+6 jump straight to a window; a bare digit is still chat text", () => {
  expect(reduceKey({ ...base, activeTab: "me" }, "1", { meta: true })).toEqual({
    type: "switch-tab",
    tab: "lounge",
  });
  expect(reduceKey(base, "4", { meta: true })).toEqual({ type: "switch-tab", tab: "bounties" });
  expect(reduceKey(base, "6", { meta: true })).toEqual({ type: "switch-tab", tab: "me" });
  // Out of range, and unmodified digits, fall through to normal handling.
  expect(reduceKey(base, "7", { meta: true })).toEqual({ type: "none" });
  expect(reduceKey({ ...base, draft: "on " }, "1", {})).toEqual({
    type: "edit-draft",
    draft: "on 1",
    cursor: 4,
  });
  // A pending login code owns the keyboard — no jumping mid-paste.
  expect(reduceKey({ ...base, locked: true }, "3", { meta: true })).toEqual({ type: "none" });
});

// -- caret movement + history recall ----------------------------------------
// `cursor` is optional in NavState and unset means end-of-line, so every caller that
// predates the caret keeps appending exactly as it did.

test("Lounge: ←/→ walk the caret and stop at both ends", () => {
  const d = { ...base, draft: "hello" };
  expect(reduceKey({ ...d, cursor: 5 }, "", { leftArrow: true })).toEqual({
    type: "move-cursor",
    cursor: 4,
  });
  expect(reduceKey({ ...d, cursor: 2 }, "", { rightArrow: true })).toEqual({
    type: "move-cursor",
    cursor: 3,
  });
  // Clamped: no walking off either end.
  expect(reduceKey({ ...d, cursor: 0 }, "", { leftArrow: true })).toEqual({
    type: "move-cursor",
    cursor: 0,
  });
  expect(reduceKey({ ...d, cursor: 5 }, "", { rightArrow: true })).toEqual({
    type: "move-cursor",
    cursor: 5,
  });
});

test("Lounge: Ctrl+A / Ctrl+E jump to the ends of the line", () => {
  const d = { ...base, draft: "hello", cursor: 3 };
  expect(reduceKey(d, "a", { ctrl: true })).toEqual({ type: "move-cursor", cursor: 0 });
  expect(reduceKey(d, "e", { ctrl: true })).toEqual({ type: "move-cursor", cursor: 5 });
});

test("typing and backspace act AT the caret, not at the end", () => {
  const d = { ...base, draft: "helo", cursor: 3 };
  expect(reduceKey(d, "l", {})).toEqual({ type: "edit-draft", draft: "hello", cursor: 4 });
  expect(reduceKey(d, "", { backspace: true })).toEqual({
    type: "edit-draft",
    draft: "heo",
    cursor: 2,
  });
  // Backspace at the very start has nothing to delete.
  expect(reduceKey({ ...d, cursor: 0 }, "", { backspace: true })).toEqual({ type: "none" });
});

test("an unset cursor still means end-of-line (pre-caret callers keep appending)", () => {
  expect(reduceKey({ ...base, draft: "hi" }, "!", {})).toEqual({
    type: "edit-draft",
    draft: "hi!",
    cursor: 3,
  });
});

test("a cursor past the end of the draft is clamped rather than trusted", () => {
  // Defends the App's own clamp: state can lag a draft that shrank underneath it.
  expect(reduceKey({ ...base, draft: "hi", cursor: 99 }, "!", {})).toEqual({
    type: "edit-draft",
    draft: "hi!",
    cursor: 3,
  });
});

test("Lounge: ↑/↓ ask for history, and the menus still win when open", () => {
  expect(reduceKey(base, "", { upArrow: true })).toEqual({ type: "history", to: "prev" });
  expect(reduceKey(base, "", { downArrow: true })).toEqual({ type: "history", to: "next" });
  // The `/` palette and `@` mention menus capture ↑/↓ for their own selection.
  expect(reduceKey({ ...base, paletteOpen: true }, "", { upArrow: true })).toEqual({
    type: "palette-move",
    delta: -1,
  });
  expect(reduceKey({ ...base, mentionOpen: true }, "", { upArrow: true })).toEqual({
    type: "mention-move",
    delta: -1,
  });
  // …as does roster focus, where ↑/↓ walk the member list.
  expect(reduceKey({ ...base, loungeFocus: "roster" }, "", { upArrow: true })).toEqual({
    type: "roster-move",
    delta: -1,
  });
});

test("DM composers get the same caret + history bindings as the Lounge", () => {
  const thread = { ...base, activeTab: "dms" as const, dmView: "thread" as const, draft: "hi" };
  expect(reduceKey({ ...thread, cursor: 2 }, "", { leftArrow: true })).toEqual({
    type: "move-cursor",
    cursor: 1,
  });
  expect(reduceKey(thread, "", { downArrow: true })).toEqual({ type: "history", to: "next" });
  // The inbox is a list, not a composer — ↑/↓ stay selection moves there.
  const inbox = { ...base, activeTab: "dms" as const, dmView: "inbox" as const, selection: 1 };
  expect(reduceKey(inbox, "", { upArrow: true })).toEqual({
    type: "move-selection",
    selection: 0,
  });
});

// -- how the caret is drawn -------------------------------------------------

test("caretSegments puts the block ON the caret and keeps the line width stable", () => {
  // Mid-line, blinking on: the block covers "l"; off: the "l" shows through.
  expect(caretSegments("hello", 2, true)).toEqual({ before: "he", at: "█", after: "lo" });
  expect(caretSegments("hello", 2, false)).toEqual({ before: "he", at: "l", after: "lo" });
  // Same rendered width either way — the tail must not jitter as the cursor blinks.
  const on = caretSegments("hello", 2, true);
  const off = caretSegments("hello", 2, false);
  expect((on.before + on.at + on.after).length).toBe((off.before + off.at + off.after).length);
});

test("caretSegments at end-of-line blinks against a space, not a character", () => {
  expect(caretSegments("hi", 2, true)).toEqual({ before: "hi", at: "█", after: "" });
  expect(caretSegments("hi", 2, false)).toEqual({ before: "hi", at: " ", after: "" });
  expect(caretSegments("", 0, false)).toEqual({ before: "", at: " ", after: "" });
});

test("caretSegments clamps a caret that outran the draft", () => {
  expect(caretSegments("hi", 99, false)).toEqual({ before: "hi", at: " ", after: "" });
  expect(caretSegments("hi", -5, true)).toEqual({ before: "", at: "█", after: "i" });
});

test("history is withheld while a login code is pending — it would eat the code", () => {
  // `locked` means the draft holds a pasted login code. Recalling history there would
  // replace it and the next Enter would submit the wrong value, so ↑/↓ stay scrolls.
  const locked = { ...base, locked: true, draft: "482913" };
  expect(reduceKey(locked, "", { upArrow: true })).toEqual({ type: "scroll", to: "up" });
  expect(reduceKey(locked, "", { downArrow: true })).toEqual({ type: "scroll", to: "down" });
  // Caret moves are still allowed: they cannot lose text.
  expect(reduceKey({ ...locked, cursor: 3 }, "", { leftArrow: true })).toEqual({
    type: "move-cursor",
    cursor: 2,
  });
});
