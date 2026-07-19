# @termchat/cli

The `termchat` Bun CLI: the lounge TUI, presence daemon, Claude Code hooks, GitHub
login, and the safe `settings.json` installer.

## Install

```sh
# curl bootstrap (ensures Bun, wires Claude Code hooks safely):
curl -fsSL https://termchat.sh/install.sh | sh

# or Homebrew (once the tap is published — see Formula/termchat.rb):
brew install oviatohq/termchat/termchat
```

## Commands

```sh
termchat chat [room]                             # open the lounge chat TUI (Ink/React)
termchat login                                   # link this terminal via GitHub
termchat logout                                  # forget the stored session
termchat whoami                                  # show the current identity
termchat install [--statusline] [--edge <url>]   # wire Claude Code hooks safely
termchat uninstall                               # remove only termchat's entries
termchat daemon                                  # run the presence daemon
termchat hook <event>                            # one-shot hook (Claude Code calls this)
termchat online                                  # print the current presence line
```

## Lounge TUI

`termchat chat [room]` opens a split-screen Ink/React pane: a roster sidebar
(signed-in members + their coarse topic, plus a lurker count) beside the live
chat transcript, with a command input. Slash commands (ported from the
prototype's surface): `/join <room>`, `/rooms`, `/topic <tag>`, `/who`, `/help`,
`/quit`. Anything else is sent as a message. Signed-in (via `termchat login`)
to post; anyone may read anonymously.

The interactive Ink view is a thin layer over a headless `LoungeClient`, so the
chat logic is unit-tested under `bun test` (with a fake socket) and the render
is tested with `ink-testing-library`.

## How presence flows

1. `SessionStart` → ensures the singleton **daemon** is running.
2. The **daemon** holds one hibernatable WebSocket to the edge and atomically
   mirrors every broadcast to `~/.termchat/online.line`. It is the *only*
   component that touches the network.
3. `UserPromptSubmit`/`Stop`/`SessionEnd` → one-shot `POST /presence/state`
   (busy/idle). **No raw prompt text, `cwd`, or paths ever leave the machine.**
4. The status line is `statusline.sh` = `cat ~/.termchat/online.line` — zero
   network on the hot path.

## Invariants (tested)

- Hooks are one-shot, deadline-capped, swallow all errors, and exit 0 — they
  never block Claude Code (PRD §6.4).
- Hooks read only the session id from stdin; everything else is stripped by Zod
  (PRD §11.3).
- The installer backs up, deep-merges, is idempotent, tags its entries, honors
  `CLAUDE_CONFIG_DIR`, and never clobbers a user's own hooks or status line.

## Env

| Var                          | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `TERMCHAT_EDGE`              | Edge base URL (default `https://termchat.sh`; use `http://127.0.0.1:8787` for local dev). |
| `TERMCHAT_HOME`              | State dir (default `~/.termchat`).                 |
| `CLAUDE_CONFIG_DIR`          | Claude Code config dir (default `~/.claude`).      |
| `TERMCHAT_BIN_DIR`           | Launcher dir (default `~/.local/bin`).             |
| `NO_COLOR` / `TERMCHAT_NO_COLOR` | Disable ANSI color in the status line.         |
| `TERMCHAT_DISABLE_DAEMON_SPAWN`  | `1` → `SessionStart` won't spawn the daemon.   |
