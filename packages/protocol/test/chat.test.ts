import { expect, test } from "bun:test";
import {
  ClientChatMessage,
  PresenceStateUpdate,
  RoomName,
  ServerChatMessage,
  TopicTag,
} from "../src/index.ts";

test("TopicTag and RoomName accept allow-list values and reject others", () => {
  expect(TopicTag.safeParse("rust").success).toBe(true);
  expect(TopicTag.safeParse("not-a-real-tag").success).toBe(false);
  expect(RoomName.safeParse("general").success).toBe(true);
  expect(RoomName.safeParse("#rust").success).toBe(false);
});

test("PresenceStateUpdate only accepts an allow-list topic tag (no free text) — §11.3", () => {
  expect(
    PresenceStateUpdate.safeParse({ clientId: "c", state: "busy", topic: "rust" }).success,
  ).toBe(true);
  expect(
    PresenceStateUpdate.safeParse({ clientId: "c", state: "busy", topic: "my secret prompt text" })
      .success,
  ).toBe(false);
  // topic is optional
  expect(PresenceStateUpdate.safeParse({ clientId: "c", state: "idle" }).success).toBe(true);
});

test("ClientChatMessage validates msg + topic shapes", () => {
  expect(ClientChatMessage.safeParse({ type: "msg", text: "hello" }).success).toBe(true);
  expect(ClientChatMessage.safeParse({ type: "msg", text: "" }).success).toBe(false);
  expect(ClientChatMessage.safeParse({ type: "topic", tag: "rust" }).success).toBe(true);
  expect(ClientChatMessage.safeParse({ type: "topic", tag: "nope" }).success).toBe(false);
  expect(ClientChatMessage.safeParse({ type: "report", target: "spammer" }).success).toBe(true);
  expect(ClientChatMessage.safeParse({ type: "report", target: "" }).success).toBe(false);
  expect(ClientChatMessage.safeParse({ type: "bogus" }).success).toBe(false);
});

test("ServerChatMessage validates msg/roster/system", () => {
  expect(ServerChatMessage.safeParse({ type: "msg", from: "a", text: "hi", ts: 1 }).success).toBe(
    true,
  );
  expect(
    ServerChatMessage.safeParse({ type: "roster", room: "rust", members: [], guests: 0 }).success,
  ).toBe(true);
  expect(ServerChatMessage.safeParse({ type: "system", text: "hi" }).success).toBe(true);
});
