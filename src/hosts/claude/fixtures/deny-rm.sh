#!/bin/sh
input=$(cat)
case "$input" in
  *'"command":"rm '*|*' rm '*) echo "rm is not allowed" >&2; exit 2 ;;
esac
exit 0
