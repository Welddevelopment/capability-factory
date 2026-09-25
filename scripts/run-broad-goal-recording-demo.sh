#!/bin/zsh
set -euo pipefail

typeset CF_RECORDING_ROOT="${0:A:h:h}"
typeset CF_RECORDING_NODE

if command -v node >/dev/null 2>&1; then
  CF_RECORDING_NODE="$(command -v node)"
elif [[ -x "/Users/joeljeon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  CF_RECORDING_NODE="/Users/joeljeon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  print -u2 "Node.js was not found. Open the project in Codex once so its workspace runtime is available."
  exit 1
fi

cd "$CF_RECORDING_ROOT"
exec "$CF_RECORDING_NODE" node_modules/tsx/dist/cli.mjs apps/console/server/run-broad-goal-recording-demo.ts
