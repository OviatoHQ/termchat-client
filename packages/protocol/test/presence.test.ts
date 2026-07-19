import { expect, test } from "bun:test";
import {
  OnlineResponse,
  PresenceSnapshot,
  PresenceStateUpdate,
  buildPresenceSnapshot,
} from "../src/presence.ts";

test("PresenceStateUpdate accepts a valid busy update", () => {
  expect(
    PresenceStateUpdate.safeParse({ clientId: "c1", sessionId: "s1", state: "busy" }).success,
  ).toBe(true);
});

test("PresenceStateUpdate strips unknown keys (no prompt leak at the schema, PRD §11.3)", () => {
  const parsed = PresenceStateUpdate.parse({
    clientId: "c1",
    state: "idle",
    prompt: "my secret prompt",
    cwd: "/Users/secret",
  });
  expect("prompt" in parsed).toBe(false);
  expect("cwd" in parsed).toBe(false);
  expect(parsed).toEqual({ clientId: "c1", state: "idle" });
});

test("PresenceStateUpdate rejects an invalid state and an empty clientId", () => {
  expect(PresenceStateUpdate.safeParse({ clientId: "c1", state: "weird" }).success).toBe(false);
  expect(PresenceStateUpdate.safeParse({ clientId: "", state: "busy" }).success).toBe(false);
});

test("buildPresenceSnapshot tags the envelope and validates", () => {
  const snapshot = buildPresenceSnapshot({ online: 3, waiting: 1, experts: 0 }, 1000);
  expect(snapshot).toEqual({ type: "presence", online: 3, waiting: 1, experts: 0, ts: 1000 });
  expect(PresenceSnapshot.safeParse(snapshot).success).toBe(true);
});

test("OnlineResponse validates the warm-bootstrap shape", () => {
  expect(OnlineResponse.safeParse({ online: 0, waiting: 0, experts: 0, ts: 1 }).success).toBe(true);
  expect(OnlineResponse.safeParse({ online: -1, waiting: 0, experts: 0, ts: 1 }).success).toBe(
    false,
  );
});
