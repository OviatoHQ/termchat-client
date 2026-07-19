#!/usr/bin/env bash
# termchat status line — pure local file read; no sockets, no subprocess beyond
# cat, so it can never block or blank the Claude Code status bar (PRD §6.3).
#
# This is one of only two non-TypeScript files in the product (the other is the
# shell bootstrap installer). It contains no application logic.
cat "${TERMCHAT_HOME:-$HOME/.termchat}/online.line" 2>/dev/null || true
