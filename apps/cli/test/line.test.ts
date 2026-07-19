import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLine, writeOnlineLine } from "../src/line.ts";

test("renderLine always shows online and hides zero waiting/experts", () => {
  expect(renderLine({ online: 1284, waiting: 0, experts: 0 }, false)).toBe(
    "💬 chat ● 1,284 online",
  );
});

test("renderLine shows online and experts joined by ' - '", () => {
  expect(renderLine({ online: 12, waiting: 0, experts: 4 }, false)).toBe(
    "💬 chat ● 12 online - 4 expert",
  );
});

test("renderLine includes waiting when non-zero", () => {
  expect(renderLine({ online: 5, waiting: 2, experts: 0 }, false)).toBe(
    "💬 chat ● 5 online - 2 waiting",
  );
});

test("renderLine with color wraps the dot and text in ANSI", () => {
  const out = renderLine({ online: 1, waiting: 0, experts: 0 }, true);
  expect(out).toContain("\x1b[32m●"); // dot stays green
  expect(out).toContain("💬 chat");
  expect(out).toContain("1 online");
});

let home: string;
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-line-"));
  previous = process.env.TERMCHAT_HOME;
  process.env.TERMCHAT_HOME = home;
});

afterEach(() => {
  if (previous === undefined) {
    delete process.env.TERMCHAT_HOME;
  } else {
    process.env.TERMCHAT_HOME = previous;
  }
  rmSync(home, { recursive: true, force: true });
});

test("writeOnlineLine writes atomically and leaves no temp files", () => {
  writeOnlineLine("● termchat: 3 online");
  expect(readFileSync(join(home, "online.line"), "utf8")).toBe("● termchat: 3 online\n");
  const leftovers = readdirSync(home).filter((name) => name.includes(".tmp-"));
  expect(leftovers).toHaveLength(0);
});
