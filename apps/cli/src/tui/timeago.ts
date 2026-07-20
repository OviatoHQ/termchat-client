/**
 * Compact relative-time labels for the DM inbox ("2 mins ago"). Pure and `now`-injected
 * so it's deterministic under `bun test` (no wall-clock reads here — the App feeds a
 * ticking `now`, see the `useNow` hook). Floors each bucket so it never overstates age.
 */
export function timeAgo(ts: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  // Older than ~a month: a short absolute date rather than an unwieldy count.
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Ultra-compact age for tight list columns — the bounty board's "open 2h" / "open 40m".
 * Single-unit, floored, no "ago" suffix: `now`, `40m`, `2h`, `3d`, `5w`. Same `now`
 * injection as timeAgo so it stays deterministic under test.
 */
export function ageShort(ts: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
