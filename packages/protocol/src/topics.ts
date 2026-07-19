import { z } from "zod";

/**
 * Coarse, public topic tags (PRD §11.3). A prompt is classified **locally** by
 * the CLI into at most one of these tags; only the tag — never the prompt text,
 * cwd, or paths — ever crosses the wire. The wire schema validates against this
 * fixed allow-list, so even a buggy classifier cannot leak free text.
 */
export const TOPIC_TAGS = [
  "react",
  "nextjs",
  "vue",
  "svelte",
  "typescript",
  "javascript",
  "node",
  "python",
  "django",
  "rust",
  "go",
  "java",
  "ruby",
  "php",
  "cpp",
  "sql",
  "postgres",
  "docker",
  "kubernetes",
  "cloud",
  "ci",
  "git",
  "testing",
  "ai-agents",
  "ml",
  "mobile",
  "stuck",
] as const;

export const TopicTag = z.enum(TOPIC_TAGS);
export type TopicTag = z.infer<typeof TopicTag>;

/** Curated lounge chat rooms for Phase 1 (sharded by topic; one DO each). */
export const LOUNGE_ROOMS = [
  "general",
  "rust",
  "nextjs",
  "python",
  "typescript",
  "ai-agents",
  "devops",
  "stuck",
] as const;

export const RoomName = z.enum(LOUNGE_ROOMS);
export type RoomName = z.infer<typeof RoomName>;
