import { expect, test } from "bun:test";
import { confirmsYes, nickIntent } from "../src/tui/App.tsx";

/**
 * The `/nick` decision + confirm-answer parsing, tested as pure functions. (The
 * React plumbing that wires these — `setPendingNick` and the `submit` interceptor —
 * mirrors the proven `pendingLogin` flow; ink raw-mode input can't be driven under
 * `bun test`, which is why the TUI's other tests all use `staticInput`.)
 */

test("confirmsYes: Enter (empty) and y/yes confirm; anything else cancels", () => {
  expect(confirmsYes("")).toBe(true); // Enter = default yes
  expect(confirmsYes("y")).toBe(true);
  expect(confirmsYes("Y")).toBe(true);
  expect(confirmsYes(" yes ")).toBe(true);
  expect(confirmsYes("n")).toBe(false);
  expect(confirmsYes("no")).toBe(false);
  expect(confirmsYes("chef")).toBe(false);
});

test("nickIntent: a verified user is asked to confirm a valid name", () => {
  expect(nickIntent("chef", true)).toEqual({ kind: "confirm", name: "chef" });
});

test("nickIntent: a guest applies a valid name immediately (no confirm)", () => {
  expect(nickIntent("cool_guest-1", false)).toEqual({ kind: "apply", name: "cool_guest-1" });
});

test("nickIntent: invalid names are rejected locally with a hint (never sent)", () => {
  for (const bad of ["x" /* too short */, "-bad" /* leading - */, "café" /* non-ascii */, ""]) {
    const intent = nickIntent(bad, true);
    expect(intent.kind).toBe("invalid");
  }
});
