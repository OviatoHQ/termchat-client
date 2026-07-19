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

test("DMs is a hybrid pane: arrows move threads, typing edits the draft", () => {
  const dms = { ...base, activeTab: "dms" as const, itemCount: 3, selection: 1 };
  expect(reduceKey(dms, "", { downArrow: true })).toEqual({ type: "move-selection", selection: 2 });
  expect(reduceKey(dms, "", { upArrow: true })).toEqual({ type: "move-selection", selection: 0 });
  expect(reduceKey(dms, "h", {})).toEqual({ type: "edit-draft", draft: "h" });
});

test("DMs Enter: opens the highlighted thread when empty, else sends the draft", () => {
  const dms = { ...base, activeTab: "dms" as const, itemCount: 3, selection: 1 };
  expect(reduceKey(dms, "", { return: true })).toEqual({ type: "activate" });
  expect(reduceKey({ ...dms, draft: "hey" }, "", { return: true })).toEqual({
    type: "submit",
    line: "hey",
  });
});
