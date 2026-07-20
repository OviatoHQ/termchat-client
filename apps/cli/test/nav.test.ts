import { expect, test } from "bun:test";
import { type NavState, reduceKey } from "../src/tui/nav.ts";

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
  });
  expect(reduceKey({ ...base, draft: "hi" }, "", { backspace: true })).toEqual({
    type: "edit-draft",
    draft: "h",
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
  expect(reduceKey(thread, "h", {})).toEqual({ type: "edit-draft", draft: "h" });
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
  expect(reduceKey(pal, "l", {})).toEqual({ type: "edit-draft", draft: "/cal" }); // keeps filtering
  expect(reduceKey(pal, "", { backspace: true })).toEqual({ type: "edit-draft", draft: "/c" });
});

test("DMs new-DM composer: typing edits; Enter submits the handle line; Esc goes back", () => {
  const compose = {
    ...base,
    activeTab: "dms" as const,
    dmView: "new" as const,
    itemCount: 0,
    draft: "@chef",
  };
  expect(reduceKey(compose, "x", {})).toEqual({ type: "edit-draft", draft: "@chefx" });
  expect(reduceKey(compose, "", { return: true })).toEqual({ type: "submit", line: "@chef" });
  expect(reduceKey(compose, "", { escape: true })).toEqual({ type: "back" });
});
