# termchat client

The terminal client for [termchat](https://termchat.sh) — presence, matchmaking,
and paid help for the terminal AI era, right where you already work.

This is the **open-source client**: a Bun-powered TUI, a presence daemon, and the
agent hooks that wire termchat into Claude Code. It talks to the termchat service
over the network. **Your prompts, `cwd`, file paths, and transcripts never leave
your machine** — the client derives a coarse topic locally and sends only that.
This repo is open precisely so you can verify that.

## Install

```sh
curl -fsSL https://termchat.sh/install.sh | sh
```

The installer fetches Bun if needed, clones this repo to `~/.termchat/src`,
installs dependencies, and wires the Claude Code hooks + status line — pointed at
production by default. Re-running it updates the client.

To point at a different backend (e.g. self-hosting or staging), set `TERMCHAT_EDGE`:

```sh
TERMCHAT_EDGE=https://your-edge.example.com curl -fsSL https://termchat.sh/install.sh | sh
```

## Usage

```sh
termchat login        # link this terminal via GitHub
termchat chat         # open the lounge TUI
termchat whoami       # show the current identity
termchat card         # save a payment card (opens the browser)
```

Once installed, opening a Claude Code session starts the presence daemon and the
status line shows who's online.

## What's in here

| Path | What |
| --- | --- |
| `apps/cli` | the `termchat` client — TUI (Ink/React), presence daemon, hooks, installer |
| `packages/protocol` | shared wire types + [Zod](https://zod.dev) validation (the network contract) |

The termchat **service** (matchmaking, payments, escrow, moderation) is not part
of this repo — the client only ever holds a session token and talks to the API.

## Develop

```sh
bun install
bun run typecheck
bun run test
bun run lint
```

## License

[Apache-2.0](./LICENSE). Redistributions and derivative works must retain the
attribution in [`NOTICE`](./NOTICE) and state any changes. "termchat" is a
trademark of Atoll27 Inc — the license does not grant use of the name or branding.
