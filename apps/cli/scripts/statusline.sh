#!/usr/bin/env bash
# termchat status line (reference: the no-prior case) — a pure local file read of
# the presence line; no sockets, no subprocess beyond cat, so termchat's own
# contribution can never block or reach the network (PRD §6.3).
#
# When a status line is ALREADY configured at install time, the generated script
# (apps/cli/src/claude-adapter.ts) instead wraps that pre-existing command and
# appends this presence line to it — see writeStatuslineScript(). termchat's own
# part stays a network-free file read either way.
#
# This is one of only two non-TypeScript files in the product (the other is the
# shell bootstrap installer). It contains no termchat application logic.
cat "${TERMCHAT_HOME:-$HOME/.termchat}/online.line" 2>/dev/null || true
