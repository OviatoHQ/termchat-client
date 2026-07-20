import { describe, expect, test } from "bun:test";
import { ageShort, timeAgo } from "../src/tui/timeago.ts";

const NOW = 1_000_000_000_000; // fixed reference; ts computed as NOW - offset
const ago = (ms: number): string => timeAgo(NOW - ms, NOW);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("timeAgo", () => {
  test("under a minute reads 'just now'", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * SEC)).toBe("just now");
  });

  test("minutes, singular vs plural", () => {
    expect(ago(60 * SEC)).toBe("1 min ago");
    expect(ago(2 * MIN)).toBe("2 mins ago");
    expect(ago(59 * MIN)).toBe("59 mins ago");
  });

  test("hours", () => {
    expect(ago(60 * MIN)).toBe("1 hour ago");
    expect(ago(3 * HOUR)).toBe("3 hours ago");
    expect(ago(23 * HOUR)).toBe("23 hours ago");
  });

  test("days then weeks", () => {
    expect(ago(DAY)).toBe("1 day ago");
    expect(ago(6 * DAY)).toBe("6 days ago");
    expect(ago(7 * DAY)).toBe("1 week ago");
    expect(ago(3 * 7 * DAY)).toBe("3 weeks ago");
  });

  test("older than ~a month falls back to an absolute date", () => {
    const label = ago(60 * DAY);
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("future timestamps (clock skew) clamp to 'just now'", () => {
    expect(timeAgo(NOW + 5 * MIN, NOW)).toBe("just now");
  });
});

describe("ageShort", () => {
  const age = (ms: number): string => ageShort(NOW - ms, NOW);
  test("single-unit, floored, no 'ago' suffix", () => {
    expect(age(0)).toBe("now");
    expect(age(59 * SEC)).toBe("now");
    expect(age(MIN)).toBe("1m");
    expect(age(40 * MIN)).toBe("40m");
    expect(age(2 * HOUR)).toBe("2h");
    expect(age(23 * HOUR)).toBe("23h");
    expect(age(3 * DAY)).toBe("3d");
    expect(age(2 * 7 * DAY)).toBe("2w");
  });
  test("future timestamps clamp to 'now'", () => {
    expect(ageShort(NOW + 5 * MIN, NOW)).toBe("now");
  });
});
