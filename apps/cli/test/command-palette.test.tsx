import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { matchCommands } from "../src/commands.ts";
import { CommandPalette } from "../src/tui/App.tsx";

test("empty matches render nothing (menu closed)", () => {
  const { lastFrame } = render(<CommandPalette matches={[]} sel={0} />);
  expect((lastFrame() ?? "").trim()).toBe("");
});

test("renders /name + description rows", () => {
  const matches = matchCommands("/ca"); // call, card
  const { lastFrame } = render(<CommandPalette matches={matches} sel={0} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("/call");
  expect(frame).toContain("Call a paid expert for a live session");
  expect(frame).toContain("/card");
});

test("long list windows to 8 rows + a 'more' hint, keeping the selection visible", () => {
  const all = matchCommands("/"); // every command
  expect(all.length).toBeGreaterThan(8);
  const sel = all.length - 1; // select the last → windowing must scroll to it
  const selName = all[sel]?.name ?? "";
  const { lastFrame } = render(<CommandPalette matches={all} sel={sel} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain(`/${selName}`); // selected row is on-screen
  expect(frame).toMatch(/more/); // truncation hint present
  const rows = frame.split("\n").filter((l) => /\s\/[a-z]/.test(l)).length;
  expect(rows).toBeLessThanOrEqual(8); // never more than the window
});
