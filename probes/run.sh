#!/usr/bin/env bash
# Run a probe inside the live page (tools/render.mjs's probe-runner subcommand).
# Usage: probes/run.sh probes/foo.js [args...]
set -eu
cd "$(dirname "$0")/.."
exec node tools/render.mjs eval "$@"
