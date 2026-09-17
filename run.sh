#!/usr/bin/env sh
# Linux and macOS: checks Node, then runs the benchmark with your options.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is needed: https://nodejs.org (or: brew install node / your package manager)"; exit 1
fi
exec node bench.mjs "$@"
