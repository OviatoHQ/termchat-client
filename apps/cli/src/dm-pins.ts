import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { termchatHome } from "./config.ts";

/**
 * TOFU (trust-on-first-use) key pins for DMs (docs/DMS.md). We pin a peer's public key
 * on first sight and warn loudly if it ever changes — the v1 mitigation against a
 * key-substitution MITM by the edge. Stored plaintext (public keys aren't secret) at
 * `~/.termchat/dms/pins.json`, mapping peer handle → base64 public key.
 */
export type PinMap = Record<string, string>;

function pinsPath(): string {
  return join(termchatHome(), "dms", "pins.json");
}

export function loadPins(): PinMap {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pinsPath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: PinMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {}; // absent / unreadable → no pins yet
  }
}

export function savePins(pins: PinMap): void {
  mkdirSync(join(termchatHome(), "dms"), { recursive: true, mode: 0o700 });
  writeFileSync(pinsPath(), `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
}
