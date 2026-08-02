#!/bin/bash
# Convenience wrapper: probes/run.sh <probe.js> [args] == node tools/shot.mjs eval <probe.js> [args]
cd "$(dirname "$0")/.." || exit 1
exec node tools/shot.mjs eval "$@"
