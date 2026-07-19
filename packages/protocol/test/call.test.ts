import { expect, test } from "bun:test";
import { shouldEmitConnected } from "../src/call.ts";

// THE HINGE (Phase 3A.1): the billing clock must start on AUDIO flowing, never on
// mere room-join. The call page emits `{type:"connected"}` only the first time a
// remote participant's audio is enabled.

test("a JOINED-but-SILENT participant does NOT start the clock", () => {
  // audioUpdate with audioEnabled=false (joined, mic not yet flowing) → no connected.
  expect(shouldEmitConnected(false, false)).toBe(false);
});

test("the clock starts the first time audio is actually flowing", () => {
  expect(shouldEmitConnected(false, true)).toBe(true);
});

test("connected is emitted exactly once — a later audio toggle does not re-fire it", () => {
  expect(shouldEmitConnected(true, true)).toBe(false); // already seen
  expect(shouldEmitConnected(true, false)).toBe(false); // mute after connect ≠ a new connect
});
