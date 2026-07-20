/**
 * The termchat logo shown at the top of `termchat install`: the brand mark — two
 * offset squares (amber top-right, lime bottom-left, exactly as in the web wordmark,
 * favicon, and landing logo) — next to the "termchat" wordmark and a short
 * tagline. Truecolor ANSI when stdout is a TTY and NO_COLOR is unset; degrades to
 * plain text otherwise (pipes, CI, logs). Pure output, no app logic.
 */

const AMBER = "\x1b[38;2;227;167;55m"; // #E3A737 — the top-right square
const LIME = "\x1b[38;2;198;221;86m"; // #C6DD56 — the bottom-left square
const WORD = "\x1b[38;2;203;197;156m"; // #CBC59C — the wordmark
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const TAGLINE = "Your agent is running. You don't have to wait alone.";

function useColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

/**
 * Two rows: amber square offset right on top, lime square on the bottom-left — the
 * diagonal two-square mark. Terminal cells are ~1:2 (w:h), so a 2-wide, 1-tall block
 * reads as a square. The wordmark sits to the right, the tagline just beneath it.
 */
export function renderBanner(): string {
  if (!useColor()) {
    return `\n  ██   termchat\n██     ${TAGLINE}\n\n`;
  }
  return (
    `\n  ${AMBER}██${RESET}   ${BOLD}${WORD}termchat${RESET}\n` +
    `${LIME}██${RESET}     ${DIM}${TAGLINE}${RESET}\n\n`
  );
}

export function printBanner(): void {
  process.stdout.write(renderBanner());
}
