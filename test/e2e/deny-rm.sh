#!/bin/sh
# Example PreToolUse hook: blocks Bash commands that contain "rm " (exit 2, reason on stderr).
input=$(cat)
case "$input" in
  *'"rm '*|*' rm '*|*'rm -'*)
    echo "rm is blocked by the example deny-rm hook" >&2
    exit 2
    ;;
esac
exit 0
