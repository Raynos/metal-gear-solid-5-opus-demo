#!/bin/bash
# usage: _run.sh <verify-probe> [args...]  — shims g/THREE/ARGV for round-6/7 probes
P="$1"; shift
ROOT=/Users/raynos/projects/game-demos/metal-gear-solid-5-opus-demo
OUT=$ROOT/probes/r8audit/_tmp.js
{ echo "const g = window.__GAME; const THREE = g.THREE; const ARGV = (typeof ARGS !== 'undefined' && ARGS) || [];"; cat "$P"; } > "$OUT"
node "$ROOT/tools/render.mjs" eval "$OUT" "$@"
