import { expect, test } from "bun:test";
import { parseCommand } from "../src/commands.ts";

test("plain text becomes a message", () => {
  expect(parseCommand("hello there")).toEqual({ kind: "message", text: "hello there" });
});

test("blank input is null", () => {
  expect(parseCommand("   ")).toBeNull();
});

test("slash commands parse with args and aliases", () => {
  expect(parseCommand("/join rust")).toEqual({ kind: "join", room: "rust" });
  expect(parseCommand("/j nextjs")).toEqual({ kind: "join", room: "nextjs" });
  expect(parseCommand("/topic docker")).toEqual({ kind: "topic", tag: "docker" });
  expect(parseCommand("/report spammer")).toEqual({ kind: "report", user: "spammer" });
  expect(parseCommand("/rooms")).toEqual({ kind: "rooms" });
  expect(parseCommand("/who")).toEqual({ kind: "who" });
  expect(parseCommand("/help")).toEqual({ kind: "help" });
  expect(parseCommand("/q")).toEqual({ kind: "quit" });
});

test("parses account/browser commands including /dashboard", () => {
  expect(parseCommand("/whoami")).toEqual({ kind: "whoami" });
  expect(parseCommand("/dashboard")).toEqual({ kind: "dashboard" });
  expect(parseCommand("/dash")).toEqual({ kind: "dashboard" });
  expect(parseCommand("/card")).toEqual({ kind: "card" });
  expect(parseCommand("/onboard")).toEqual({ kind: "onboard" });
});

test("unknown slash command is reported", () => {
  expect(parseCommand("/frobnicate now")).toEqual({ kind: "unknown", name: "frobnicate" });
});

test("parses marketplace commands", () => {
  expect(parseCommand("/expert on 2 rust,go")).toEqual({
    kind: "expert",
    on: true,
    rate: 2,
    topics: ["rust", "go"],
  });
  expect(parseCommand("/expert off")).toEqual({ kind: "expert", on: false, topics: [] });
  expect(parseCommand("/summon 5 borrow checker help")).toEqual({
    kind: "summon",
    maxRate: 5,
    problem: "borrow checker help",
  });
  // Targeted summon: a leading @handle addresses one named expert; rate cap still applies.
  expect(parseCommand("/summon @chef 5 borrow checker help")).toEqual({
    kind: "summon",
    maxRate: 5,
    problem: "borrow checker help",
    target: "chef",
  });
  expect(parseCommand("/accept")).toEqual({ kind: "accept" });
  expect(parseCommand("/accept r1")).toEqual({ kind: "accept", reqId: "r1" });
  expect(parseCommand("/end")).toEqual({ kind: "end" });
  expect(parseCommand("/review 5 thanks")).toEqual({ kind: "review", stars: 5, text: "thanks" });
  expect(parseCommand("/experts")).toEqual({ kind: "experts" });
  expect(parseCommand("/earnings")).toEqual({ kind: "earnings" });
  expect(parseCommand("/dispute 7")).toEqual({ kind: "dispute", sessionId: 7 });
  expect(parseCommand("/dispute 7 never connected")).toEqual({
    kind: "dispute",
    sessionId: 7,
    reason: "never connected",
  });
  expect(parseCommand("/bounty 5 fix my borrow checker")).toEqual({
    kind: "bounty",
    priceCents: 500,
    question: "fix my borrow checker",
  });
  expect(parseCommand("/claim 12")).toEqual({ kind: "claim", bountyId: 12 });
  expect(parseCommand("/answer 12 use Arc not Rc")).toEqual({
    kind: "bounty_answer",
    bountyId: 12,
    answer: "use Arc not Rc",
  });
  expect(parseCommand("/accept 12")).toEqual({ kind: "bounty_accept", bountyId: 12 }); // numeric → bounty
  expect(parseCommand("/accept")).toEqual({ kind: "accept" }); // bare → summon
  expect(parseCommand("/reject 12")).toEqual({ kind: "bounty_reject", bountyId: 12 });
});

test("rejects malformed marketplace commands with a usage hint", () => {
  expect(parseCommand("/summon notanumber")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/summon @chef")).toMatchObject({ kind: "invalid" }); // handle but no rate/problem
  expect(parseCommand("/summon @ 5 help")).toMatchObject({ kind: "invalid" }); // empty handle
  expect(parseCommand("/expert on")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/review 9")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/dispute notanumber")).toMatchObject({ kind: "invalid" });
  expect(parseCommand("/bounty 5")).toMatchObject({ kind: "invalid" }); // no question
  expect(parseCommand("/claim notanumber")).toMatchObject({ kind: "invalid" });
});

test("parses account/identity commands", () => {
  expect(parseCommand("/login")).toEqual({ kind: "login" });
  expect(parseCommand("/signin")).toEqual({ kind: "login" });
  expect(parseCommand("/logout")).toEqual({ kind: "logout" });
  expect(parseCommand("/whoami")).toEqual({ kind: "whoami" });
  expect(parseCommand("/card")).toEqual({ kind: "card" });
  expect(parseCommand("/onboard")).toEqual({ kind: "onboard" });
});

test("/dm parses a target and optional first message", () => {
  expect(parseCommand("/dm bob")).toEqual({ kind: "dm", user: "bob" });
  expect(parseCommand("/dm bob yo bro ssup")).toEqual({
    kind: "dm",
    user: "bob",
    message: "yo bro ssup",
  });
  expect(parseCommand("/dm")).toEqual({ kind: "invalid", reason: "usage: /dm <user> [message]" });
});
