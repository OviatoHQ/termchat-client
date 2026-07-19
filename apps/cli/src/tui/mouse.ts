/**
 * Terminal mouse support — the low-level primitive for a mouse + keyboard driven
 * TUI. Enables xterm SGR mouse reporting (mode 1006) and parses the escape
 * sequences the terminal emits on click / drag / scroll into structured events.
 *
 * This is transport-agnostic: it works whether we drive Ink with `@zenobius/ink-mouse`
 * or read stdin ourselves. Keyboard stays with Ink's `useInput`; this adds the
 * mouse channel. See docs/UI-EXPLORATION.md for how it slots into the layout.
 *
 * SGR (1006) sequence shape:  ESC [ < b ; x ; y (M|m)
 *   b   button+modifier bitfield   x,y 1-based cell coords   M=press/down m=release/up
 */

/** Turn on button + drag-motion + SGR mouse reporting. Write to stdout on start. */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
/** Turn it back off. Write on exit (and always restore, even on crash). */
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export type MouseEventType = "down" | "up" | "move" | "scroll";
export type MouseButton = "left" | "middle" | "right" | "none";

export interface MouseEvent {
  type: MouseEventType;
  button: MouseButton;
  /** 1-based column and row, as the terminal reports them. */
  x: number;
  y: number;
  /** Only for scroll events. */
  scroll?: "up" | "down";
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the literal mouse-report prefix.
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const BUTTONS: MouseButton[] = ["left", "middle", "right", "none"];

/**
 * Parse every SGR mouse event in a raw stdin chunk (there may be 0, 1, or many).
 * Non-mouse bytes (keystrokes) are ignored — route those through the keyboard path.
 */
export function parseMouseEvents(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  SGR.lastIndex = 0;
  let m: RegExpExecArray | null = SGR.exec(chunk);
  while (m !== null) {
    const code = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const isRelease = m[4] === "m";

    const shift = (code & 4) !== 0;
    const meta = (code & 8) !== 0;
    const ctrl = (code & 16) !== 0;
    const base = { x, y, shift, meta, ctrl };

    if (code & 64) {
      // Wheel: 64 = up, 65 = down.
      events.push({ type: "scroll", button: "none", scroll: code & 1 ? "down" : "up", ...base });
    } else if (code & 32) {
      // Motion (drag) — low 2 bits still carry the held button.
      events.push({ type: "move", button: BUTTONS[code & 3] as MouseButton, ...base });
    } else {
      events.push({
        type: isRelease ? "up" : "down",
        button: BUTTONS[code & 3] as MouseButton,
        ...base,
      });
    }
    m = SGR.exec(chunk);
  }
  return events;
}
