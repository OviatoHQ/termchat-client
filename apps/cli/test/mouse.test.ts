import { expect, test } from "bun:test";
import { type MouseEvent, parseMouseEvents } from "../src/tui/mouse.ts";

// SGR sequence: ESC [ < code ; x ; y (M|m)
const seq = (code: number, x: number, y: number, end: "M" | "m") => `\x1b[<${code};${x};${y}${end}`;

test("parses a left-button press and release at cell coords", () => {
  const down = parseMouseEvents(seq(0, 12, 5, "M"));
  expect(down).toEqual([
    { type: "down", button: "left", x: 12, y: 5, shift: false, meta: false, ctrl: false },
  ] satisfies MouseEvent[]);

  const up = parseMouseEvents(seq(0, 12, 5, "m"));
  expect(up[0]).toMatchObject({ type: "up", button: "left", x: 12, y: 5 });
});

test("decodes middle/right buttons and modifier bits", () => {
  expect(parseMouseEvents(seq(1, 1, 1, "M"))[0]).toMatchObject({ button: "middle" });
  expect(parseMouseEvents(seq(2, 1, 1, "M"))[0]).toMatchObject({ button: "right" });
  // shift(4) + meta(8) + ctrl(16) on a left press = 28.
  expect(parseMouseEvents(seq(28, 3, 4, "M"))[0]).toMatchObject({
    button: "left",
    shift: true,
    meta: true,
    ctrl: true,
  });
});

test("decodes scroll up (64) and down (65)", () => {
  expect(parseMouseEvents(seq(64, 40, 10, "M"))[0]).toMatchObject({ type: "scroll", scroll: "up" });
  expect(parseMouseEvents(seq(65, 40, 10, "M"))[0]).toMatchObject({
    type: "scroll",
    scroll: "down",
  });
});

test("decodes drag-motion (32) carrying the held button", () => {
  // 32 (motion) + 0 (left) = left-drag.
  expect(parseMouseEvents(seq(32, 7, 8, "M"))[0]).toMatchObject({ type: "move", button: "left" });
});

test("extracts multiple events from one chunk and ignores keystrokes", () => {
  const chunk = `${seq(0, 1, 1, "M")}hello${seq(0, 1, 1, "m")}`;
  const evts = parseMouseEvents(chunk);
  expect(evts.map((e) => e.type)).toEqual(["down", "up"]);
});

test("returns nothing for a plain keystroke chunk", () => {
  expect(parseMouseEvents("q")).toEqual([]);
  expect(parseMouseEvents("\x1b[A")).toEqual([]); // up-arrow, not a mouse event
});
