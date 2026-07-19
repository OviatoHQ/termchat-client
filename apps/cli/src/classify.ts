import type { TopicTag } from "@termchat/protocol";

/**
 * LOCAL prompt-topic classifier (PRD §11.3). Runs entirely on the machine and
 * maps a prompt to AT MOST ONE coarse, public tag from the allow-list — it can
 * only ever return a fixed tag or null, never any substring of the prompt. The
 * raw prompt, cwd, paths, and transcripts never leave the machine; only the tag
 * is sent (and the wire schema re-validates it against the allow-list).
 */

const RULES: ReadonlyArray<readonly [TopicTag, readonly string[]]> = [
  ["nextjs", ["next.js", "nextjs", "app router", "getserversideprops", "use client"]],
  ["react", ["react", "jsx", "usestate", "useeffect", "tsx component"]],
  ["vue", ["vue", "nuxt", "pinia"]],
  ["svelte", ["svelte", "sveltekit"]],
  ["typescript", ["typescript", "tsconfig", "type error", "tsc "]],
  ["javascript", ["javascript", "npm ", "node_modules"]],
  ["node", ["node.js", "express", "fastify", "nestjs"]],
  ["python", ["python", "pip ", "venv", "pytest", "asyncio"]],
  ["django", ["django", "flask"]],
  ["rust", ["rust", "cargo", "borrow checker", "tokio", "lifetime"]],
  ["go", ["golang", "goroutine", "go mod"]],
  ["java", ["java ", "spring boot", "maven", "gradle"]],
  ["ruby", ["ruby", "rails", "bundler"]],
  ["php", ["php", "laravel", "composer"]],
  ["cpp", ["c++", "cmake", "segfault"]],
  ["sql", ["sql query", "join ", "select ", "schema migration"]],
  ["postgres", ["postgres", "psql", "pg_", "supabase"]],
  ["docker", ["docker", "dockerfile", "compose"]],
  ["kubernetes", ["kubernetes", "kubectl", "helm", "k8s"]],
  ["cloud", ["aws", "lambda", "s3 bucket", "gcp", "azure", "cloudflare"]],
  ["ci", ["ci ", "github actions", "pipeline", "workflow yml", "build failing"]],
  ["git", ["git ", "rebase", "merge conflict", "pull request"]],
  ["testing", ["unit test", "jest", "vitest", "mock ", "flaky test"]],
  ["ai-agents", ["agent", "llm", "prompt", "rag", "mcp", "tool call"]],
  ["ml", ["machine learning", "pytorch", "tensorflow", "training", "model "]],
  ["mobile", ["swift", "kotlin", "android", "ios", "react native", "flutter"]],
  ["stuck", ["i'm stuck", "im stuck", "no idea", "please help", "can't figure"]],
];

/** Derive a coarse topic tag from a prompt, or null when nothing matches. */
export function classifyTopic(prompt: string): TopicTag | null {
  const haystack = prompt.toLowerCase();
  for (const [tag, keywords] of RULES) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return tag;
  }
  return null;
}
