import { expect, test } from "bun:test";
import {
  BODY_TOP,
  BOUNTIES_LIST_OFFSET,
  CALLS_LIST_OFFSET,
  DMS_INBOX_OFFSET,
  EXPERTS_LIST_OFFSET,
  TAB_ROW,
  bodyRegions,
  hitTest,
  regionsForView,
  tabRegions,
} from "../src/tui/hit-test.ts";

// Full view for bodyRegions/regionsForView (fields default to 0 unless a test cares).
const view = (over: Partial<Parameters<typeof bodyRegions>[0]>) => ({
  activeTab: "lounge" as const,
  cols: 80,
  dmUnread: 0,
  dmView: "inbox" as const,
  dmThreadCount: 0,
  expertsCount: 0,
  meCount: 0,
  bountiesCount: 0,
  sessionsCount: 0,
  ...over,
});

test("tabRegions lays the six numbered windows left-to-right on the strip", () => {
  const regions = tabRegions("lounge", 0);
  expect(regions.map((r) => r.target)).toEqual([
    { kind: "tab", tab: "lounge" },
    { kind: "tab", tab: "dms" },
    { kind: "tab", tab: "experts" },
    { kind: "tab", tab: "bounties" },
    { kind: "tab", tab: "calls" },
    { kind: "tab", tab: "me" },
  ]);
  // `[1:lounge]` (10) at x=1; ` 2:dms ` (7) at x=11; ` 3:experts ` (11) at x=18.
  expect(regions[0]).toMatchObject({ x: 1, y: TAB_ROW, w: 10 });
  expect(regions[1]).toMatchObject({ x: 11, y: TAB_ROW, w: 7 });
  expect(regions[2]).toMatchObject({ x: 18, y: TAB_ROW, w: 11 });
  // Tabs are contiguous, no gaps.
  for (let i = 1; i < regions.length; i++) {
    expect(regions[i]?.x).toBe((regions[i - 1]?.x ?? 0) + (regions[i - 1]?.w ?? 0));
  }
});

test("the DMs unread badge widens its cell and shifts the ones after it", () => {
  const plain = tabRegions("lounge", 0);
  const badged = tabRegions("lounge", 2); // ` 2:dms(2!) ` is 4 cells wider
  expect(badged[1]?.w).toBe((plain[1]?.w ?? 0) + 4);
  expect(badged[2]?.x).toBe((plain[2]?.x ?? 0) + 4);
});

test("clicking the window strip routes to the right window", () => {
  const regions = tabRegions("lounge", 0);
  expect(hitTest(regions, 1, TAB_ROW)).toEqual({ kind: "tab", tab: "lounge" });
  expect(hitTest(regions, 11, TAB_ROW)).toEqual({ kind: "tab", tab: "dms" });
  expect(hitTest(regions, 18, TAB_ROW)).toEqual({ kind: "tab", tab: "experts" });
  expect(hitTest(regions, 29, TAB_ROW)).toEqual({ kind: "tab", tab: "bounties" });
  expect(hitTest(regions, 50, TAB_ROW)).toEqual({ kind: "tab", tab: "me" });
});

test("a click off the window strip (wrong y) misses every window", () => {
  expect(hitTest(tabRegions("lounge", 0), 1, TAB_ROW + 5)).toBeUndefined();
});

test("Experts body: one full-width row per expert, starting below the header", () => {
  const regions = bodyRegions(view({ activeTab: "experts", expertsCount: 3 }));
  expect(regions).toHaveLength(3);
  expect(regions[0]).toMatchObject({
    x: 1,
    y: BODY_TOP + 1,
    w: 80,
    target: { kind: "expert", index: 0 },
  });
  expect(hitTest(regions, 40, BODY_TOP + 1)).toEqual({ kind: "expert", index: 0 });
  expect(hitTest(regions, 40, BODY_TOP + 3)).toEqual({ kind: "expert", index: 2 });
  expect(hitTest(regions, 40, BODY_TOP + 4)).toBeUndefined(); // past the last row
});

test("Bounties body: a claimable row per bounty, then a Post row right after", () => {
  const regions = bodyRegions(view({ activeTab: "bounties", bountiesCount: 2 }));
  expect(regions).toHaveLength(3); // 2 bounties + Post
  expect(hitTest(regions, 40, BODY_TOP + BOUNTIES_LIST_OFFSET)).toEqual({
    kind: "bounty",
    index: 0,
  });
  expect(hitTest(regions, 40, BODY_TOP + BOUNTIES_LIST_OFFSET + 1)).toEqual({
    kind: "bounty",
    index: 1,
  });
  // The Post row sits immediately past the list.
  expect(hitTest(regions, 40, BODY_TOP + BOUNTIES_LIST_OFFSET + 2)).toEqual({
    kind: "bounty-post",
  });
});

test("Bounties body: an empty board still offers the Post row at the list top", () => {
  const regions = bodyRegions(view({ activeTab: "bounties", bountiesCount: 0 }));
  expect(regions).toEqual([
    expect.objectContaining({
      y: BODY_TOP + BOUNTIES_LIST_OFFSET,
      target: { kind: "bounty-post" },
    }),
  ]);
});

test("Calls body: one selectable session row per session, below header/active/subheader", () => {
  const regions = bodyRegions(view({ activeTab: "calls", sessionsCount: 2 }));
  expect(regions).toHaveLength(2);
  expect(hitTest(regions, 40, BODY_TOP + CALLS_LIST_OFFSET)).toEqual({ kind: "session", index: 0 });
  expect(hitTest(regions, 40, BODY_TOP + CALLS_LIST_OFFSET + 1)).toEqual({
    kind: "session",
    index: 1,
  });
  expect(hitTest(regions, 40, BODY_TOP + CALLS_LIST_OFFSET + 2)).toBeUndefined();
});

test("Me body: one row per action, below header/subheader/spacer", () => {
  const regions = bodyRegions(view({ activeTab: "me", cols: 60, meCount: 2 }));
  expect(regions).toHaveLength(2);
  expect(hitTest(regions, 5, BODY_TOP + 3)).toEqual({ kind: "me-action", index: 0 });
  expect(hitTest(regions, 5, BODY_TOP + 4)).toEqual({ kind: "me-action", index: 1 });
});

test("DMs inbox: '+ Send new DM' is row 0, threads follow (index i → threads[i-1])", () => {
  const regions = bodyRegions(view({ activeTab: "dms", dmView: "inbox", dmThreadCount: 2 }));
  expect(regions).toHaveLength(3); // 1 "Send new DM" + 2 threads
  expect(hitTest(regions, 5, BODY_TOP + DMS_INBOX_OFFSET)).toEqual({ kind: "dm-row", index: 0 });
  expect(hitTest(regions, 5, BODY_TOP + DMS_INBOX_OFFSET + 1)).toEqual({
    kind: "dm-row",
    index: 1,
  });
  expect(hitTest(regions, 5, BODY_TOP + DMS_INBOX_OFFSET + 2)).toEqual({
    kind: "dm-row",
    index: 2,
  });
  expect(hitTest(regions, 5, BODY_TOP + DMS_INBOX_OFFSET + 3)).toBeUndefined();
});

test("DMs inbox with no threads still has the '+ Send new DM' row", () => {
  const regions = bodyRegions(view({ activeTab: "dms", dmView: "inbox", dmThreadCount: 0 }));
  expect(regions).toHaveLength(1);
  expect(hitTest(regions, 5, BODY_TOP + DMS_INBOX_OFFSET)).toEqual({ kind: "dm-row", index: 0 });
});

test("DMs thread: the '‹ see all DMs' back action is the only body target", () => {
  const regions = bodyRegions(view({ activeTab: "dms", dmView: "thread", dmThreadCount: 5 }));
  expect(regions).toHaveLength(1);
  expect(hitTest(regions, 5, BODY_TOP)).toEqual({ kind: "dm-back" });
});

test("DMs new-DM composer has no body click targets (Esc cancels)", () => {
  expect(bodyRegions(view({ activeTab: "dms", dmView: "new", dmThreadCount: 3 }))).toHaveLength(0);
});

test("Lounge and Calls have no body click targets (only the tab strip)", () => {
  expect(bodyRegions(view({ activeTab: "lounge", expertsCount: 5, meCount: 4 }))).toHaveLength(0);
  expect(bodyRegions(view({ activeTab: "calls", expertsCount: 5, meCount: 4 }))).toHaveLength(0);
  // regionsForView still includes the (six) tab strip cells so tabs stay clickable.
  expect(regionsForView(view({ activeTab: "lounge" }))).toHaveLength(6);
});

// ---- scrolled list windowing (scroll.ts follows the selection; hit-test must agree) ----

test("windowed list: a click on the first on-screen row resolves to `listStart`, not 0", () => {
  // 20 experts, only 6 on screen starting at index 12 (the list scrolled to follow sel).
  const v = view({ activeTab: "experts", expertsCount: 20, listStart: 12, listCount: 6 });
  const regions = bodyRegions(v);
  // Exactly the windowed rows are clickable — no more than fit.
  expect(regions).toHaveLength(6);
  // The top drawn row (BODY_TOP + EXPERTS_LIST_OFFSET) maps to item 12, not 0.
  const top = hitTest(regions, 1, BODY_TOP + EXPERTS_LIST_OFFSET);
  expect(top).toEqual({ kind: "expert", index: 12 });
  // The last drawn row maps to item 17 (12 + 6 - 1).
  const bottom = hitTest(regions, 1, BODY_TOP + EXPERTS_LIST_OFFSET + 5);
  expect(bottom).toEqual({ kind: "expert", index: 17 });
});

test("windowed bounties scrolled to the bottom still show + route the post row", () => {
  // 10 bounties + the post row = 11 selectable rows; a 4-row window scrolled to the end.
  const v = view({
    activeTab: "bounties",
    bountiesCount: 10,
    listStart: 7, // rows 7..10 → bounties 7,8,9 then the post row (index 10)
    listCount: 4,
  });
  const regions = bodyRegions(v);
  expect(regions).toHaveLength(4);
  // The last visible bounty (index 9) sits third in the window.
  expect(hitTest(regions, 1, BODY_TOP + BOUNTIES_LIST_OFFSET + 2)).toEqual({
    kind: "bounty",
    index: 9,
  });
  // The post row is the 4th window row and routes to bounty-post (the sentinel).
  expect(hitTest(regions, 1, BODY_TOP + BOUNTIES_LIST_OFFSET + 3)).toEqual({ kind: "bounty-post" });
});

test("un-windowed lists (no listCount) still render every row — backward compatible", () => {
  const v = view({ activeTab: "experts", expertsCount: 3 });
  expect(bodyRegions(v)).toHaveLength(3);
  expect(hitTest(bodyRegions(v), 1, BODY_TOP + EXPERTS_LIST_OFFSET)).toEqual({
    kind: "expert",
    index: 0,
  });
});
