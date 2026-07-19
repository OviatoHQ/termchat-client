import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallState,
  readCallState,
  renderCallLine,
  renderLine,
  writeCallState,
  writeOnlineLine,
} from "../src/line.ts";

test("renderLine shows the wire idle line and hides zero experts", () => {
  expect(renderLine({ online: 1284, waiting: 0, experts: 0 }, false)).toBe("▄▀ termchat 1,284");
});

test("renderLine appends ⚡ + the experts count when non-zero", () => {
  expect(renderLine({ online: 37, waiting: 0, experts: 4 }, false)).toBe("▄▀ termchat 37 · ⚡4");
});

test("renderLine ignores waiting (the wire idle line carries no room/queue info)", () => {
  expect(renderLine({ online: 5, waiting: 2, experts: 0 }, false)).toBe("▄▀ termchat 5");
});

test("renderLine with color makes the ▄▀ mark lime+amber and the experts count amber", () => {
  const out = renderLine({ online: 1, waiting: 0, experts: 4 }, true);
  expect(out).toContain("\x1b[38;2;202;219;106m▄"); // lime lower-half mark
  expect(out).toContain("\x1b[38;2;217;169;78m▀"); // amber upper-half mark
  expect(out).toContain("\x1b[38;2;217;169;78m⚡4"); // amber money surface
  expect(out).toContain("1"); // online count
});

test("renderCallLine reads 'accepted…' for the first seconds, then peer + elapsed time", () => {
  const call: CallState = { peer: "dana", rate: 2, startedAt: 1_000 };
  // < 3s after start → the transient accepted line.
  expect(renderCallLine(call, 2_000, false)).toBe("⚡ dana accepted · call opening in browser…");
  // 3:12 (192s) in → elapsed only, no dollar (this surface can't see pause/connect).
  expect(renderCallLine(call, 1_000 + 192_000, false)).toBe("⚡ dana 03:12");
});

test("renderCallLine never shows a running dollar (honest — no pause visibility)", () => {
  const out = renderCallLine({ peer: "dana", rate: 2, startedAt: 0 }, 192_000, true);
  expect(out).toContain("\x1b[38;2;217;169;78m⚡ dana"); // amber peer
  expect(out).toContain("03:12");
  expect(out).not.toContain("$"); // no cost on this surface
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
  writeOnlineLine("● termchat 3");
  expect(readFileSync(join(home, "online.line"), "utf8")).toBe("● termchat 3\n");
  const leftovers = readdirSync(home).filter((name) => name.includes(".tmp-"));
  expect(leftovers).toHaveLength(0);
});

test("call-state round-trips through call.json and a null clears it", () => {
  expect(readCallState()).toBeNull();
  const call: CallState = { peer: "dana", rate: 2.5, startedAt: 1234 };
  writeCallState(call);
  expect(readCallState()).toEqual(call);
  expect(readdirSync(home).filter((n) => n.includes(".tmp-"))).toHaveLength(0);
  writeCallState(null);
  expect(readCallState()).toBeNull();
  expect(existsSync(join(home, "call.json"))).toBe(false);
});
