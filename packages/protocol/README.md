# @termchat/protocol

Shared wire types and [Zod](https://zod.dev) validation schemas for termchat,
imported by both the termchat server and the CLI (`apps/cli`). Validation lives
here so the trust boundary is defined once and enforced identically on both
sides.

## Phase 0 surface

- `LOBBY_ROOM`, `PING`, `PONG` — constants for the single lounge DO + keepalive.
- `PresenceStateUpdate` — `POST /presence/state` body (`clientId`, optional
  `sessionId`, `state`).
- `PresenceSnapshot` — server → client broadcast (`online`/`waiting`/`experts`/`ts`).
- `OnlineResponse` — `GET /online` warm-bootstrap body.
- `ClientMessage` — inbound WS JSON (validated, then ignored in Phase 0).
- `buildPresenceSnapshot(counts, ts)` — envelope helper.

## Privacy invariant (PRD §11.3)

No schema here carries raw prompt text, `cwd`, file paths, or transcripts. Only
opaque identifiers and coarse counts ever cross the wire.
