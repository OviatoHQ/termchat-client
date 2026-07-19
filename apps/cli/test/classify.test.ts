import { expect, test } from "bun:test";
import { TOPIC_TAGS } from "@termchat/protocol";
import { classifyTopic } from "../src/classify.ts";

test("classifies known stacks into coarse tags", () => {
  expect(classifyTopic("help with my rust borrow checker")).toBe("rust");
  expect(classifyTopic("my Next.js app router page won't build")).toBe("nextjs");
  expect(classifyTopic("pytest keeps failing in python")).toBe("python");
});

test("returns null when nothing matches", () => {
  expect(classifyTopic("what should I name my cat")).toBeNull();
});

test("only ever emits an allow-list tag or null — never prompt text (PRD §11.3)", () => {
  const adversarial = [
    "my api token is sk-live-abc123 and my password is hunter2",
    "/Users/alice/work/secret-project/.env has the keys",
    "SELECT ssn FROM users WHERE name = 'alice'",
    "",
    "🔥".repeat(200),
    "a very long prompt ".repeat(500),
  ];
  const allowed = new Set<string>(TOPIC_TAGS);
  for (const prompt of adversarial) {
    const tag = classifyTopic(prompt);
    // The output is a fixed allow-list tag or null — never a substring of input.
    expect(tag === null || allowed.has(tag)).toBe(true);
    if (tag !== null) expect(prompt.toLowerCase()).not.toBe(tag); // sanity: not echoing input
  }
});
