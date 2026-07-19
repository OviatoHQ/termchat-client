import { expect, test } from "bun:test";
import {
  BODY_TOP,
  BOUNTIES_LIST_OFFSET,
  CALLS_LIST_OFFSET,
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
  expertsCount: 0,
  meCount: 0,
  bountiesCount: 0,
  sessionsCount: 0,
  ...over,
});

test("tabRegions lays the six tabs left-to-right on the tab row", () => {
  const regions = tabRegions();
  expect(regions.map((r) => r.target)).toEqual([
    { kind: "tab", tab: "lounge" },
    { kind: "tab", tab: "dms" },
    { kind: "tab", tab: "experts" },
    { kind: "tab", tab: "bounties" },
    { kind: "tab", tab: "calls" },
    { kind: "tab", tab: "me" },
  ]);
  // Lounge (6+3=9) at x=1; DMs (3+3=6) at x=10; Experts (7+3=10) at x=16.
  expect(regions[0]).toMatchObject({ x: 1, y: TAB_ROW, w: 9 });
  expect(regions[1]).toMatchObject({ x: 10, y: TAB_ROW, w: 6 });
  expect(regions[2]).toMatchObject({ x: 16, y: TAB_ROW, w: 10 });
  // Tabs are contiguous, no gaps.
  for (let i = 1; i < regions.length; i++) {
    expect(regions[i]?.x).toBe((regions[i - 1]?.x ?? 0) + (regions[i - 1]?.w ?? 0));
  }
});

test("clicking the tab row routes to the right tab", () => {
  const regions = tabRegions();
  expect(hitTest(regions, 1, TAB_ROW)).toEqual({ kind: "tab", tab: "lounge" });
  expect(hitTest(regions, 10, TAB_ROW)).toEqual({ kind: "tab", tab: "dms" });
  expect(hitTest(regions, 16, TAB_ROW)).toEqual({ kind: "tab", tab: "experts" });
  expect(hitTest(regions, 26, TAB_ROW)).toEqual({ kind: "tab", tab: "bounties" });
  expect(hitTest(regions, 45, TAB_ROW)).toEqual({ kind: "tab", tab: "me" });
});

test("a click off the tab row (wrong y) misses every tab", () => {
  expect(hitTest(tabRegions(), 1, TAB_ROW + 5)).toBeUndefined();
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

test("Lounge and Calls have no body click targets (only the tab strip)", () => {
  expect(bodyRegions(view({ activeTab: "lounge", expertsCount: 5, meCount: 4 }))).toHaveLength(0);
  expect(bodyRegions(view({ activeTab: "calls", expertsCount: 5, meCount: 4 }))).toHaveLength(0);
  // regionsForView still includes the (six) tab strip cells so tabs stay clickable.
  expect(regionsForView(view({ activeTab: "lounge" }))).toHaveLength(6);
});
