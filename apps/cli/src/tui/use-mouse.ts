/**
 * Ink hook that turns terminal mouse reporting on and feeds parsed events to a
 * handler (docs/UI-EXPLORATION.md, step 3). It taps Ink's own stdin event emitter
 * (the raw chunk each `readable` produces) rather than adding a second stdin
 * listener, so it never fights Ink over raw mode. `mouse.ts` does the parsing and
 * ignores non-mouse bytes; keystrokes stay on Ink's `useInput` path.
 *
 * The terminal is restored on unmount, on normal exit, on a crash, and on the
 * termination signals (SIGINT/SIGTERM/SIGHUP) — so quitting, Ctrl-C, or a `kill`
 * never leaves the user's shell spewing mouse escape codes. (Ink's own Ctrl-C is a
 * raw-mode byte, not a signal, and unmounts us — the effect cleanup covers it.)
 */
import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import { MOUSE_DISABLE, MOUSE_ENABLE, type MouseEvent, parseMouseEvents } from "./mouse.ts";

export function useMouse(active: boolean, onEvent: (event: MouseEvent) => void): void {
  const { internal_eventEmitter } = useStdin();
  // Keep the latest handler in a ref so we subscribe once, not on every render.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!active || !internal_eventEmitter) return;
    process.stdout.write(MOUSE_ENABLE);

    const onData = (chunk: unknown): void => {
      const s = typeof chunk === "string" ? chunk : String(chunk);
      for (const event of parseMouseEvents(s)) handlerRef.current(event);
    };
    internal_eventEmitter.on("input", onData);

    // Synchronous safety net for exit paths React cleanup can't catch.
    const restore = (): void => {
      process.stdout.write(MOUSE_DISABLE);
    };
    process.once("exit", restore);
    // `process.exit()` and crashes fire 'exit'; signal-based termination does NOT,
    // so restore explicitly then let the process die. Ink handles Ctrl-C as a
    // raw-mode byte (not a signal), so these don't fight it.
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const onSignal = (): void => {
      restore();
      process.exit(0);
    };
    for (const sig of signals) process.once(sig, onSignal);

    return () => {
      internal_eventEmitter.off("input", onData);
      process.off("exit", restore);
      for (const sig of signals) process.off(sig, onSignal);
      restore();
    };
  }, [active, internal_eventEmitter]);
}
