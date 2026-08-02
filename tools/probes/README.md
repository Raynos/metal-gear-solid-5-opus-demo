# The measurement tools

Read this before quoting a number from any of them.

```bash
node tools/shot.mjs probe tools/probes/perf.js          # frame time, honestly
node tools/shot.mjs probe tools/probes/determinism.js   # is a frame reproducible?
node tools/shot.mjs probe tools/probes/cascades.js      # what each shadow cascade costs
node tools/shot.mjs probe tools/probes/casterreach.js   # shadow caster cull sweep
```

`probe` is an alias for `eval`. Anything after the probe path is handed to the
probe as `ARGS` — e.g. `probe tools/probes/perf.js vista`.

## The one number that governs every other number

`perf.js` reports `ruler.noiseFloorMs`. It is **measured, not asserted**: the
probe runs its entire paired-comparison procedure with the *same* configuration
on both sides, and reports the IQR of the differences. That is the smallest
effect this machine can resolve today.

Nothing smaller than it may be quoted as a cost. `perf.js` enforces this itself —
a comparison whose |median| does not exceed its IQR prints `below noise`, never a
number.

`ruler.noiseFloorBiasMs` should be ~0. If it is not, the pairing is failing to
cancel the drift and **the whole run is void**.

## Why the numbers before this round were not measurements

Four separate faults, all now fixed, all worth knowing because they will be
reinvented otherwise:

**1. The baseline was measured once.** This machine's headless GPU drifts more
than 2x inside one run — four identical baseline blocks in a single probe
measured 17.84, 23.37, 34.96 and 39.50 ms. Timing `full` once and each variant
in sequence charges the entire drift to whichever variant ran last. That is how
"TAA is our most expensive pass" got into `tools/reference/README.md`.

Fixed by **paired adjacent differences**: baseline and variant are timed back to
back, the order alternates every pair (ABBAABBA…), and the reported cost is the
median of the per-pair differences.

Pairing at the *block* was not enough — 20-frame blocks sit ~600 ms apart and the
drift spikes inside that. Measured: same-configuration-against-itself gave an IQR
of **7.25 ms on a 27 ms frame**, i.e. nothing was resolvable at all. Pairing at
the **frame** (two frames ~30 ms apart, `gl.finish()` on each) is what made the
instrument usable. Those are latencies, not throughput, so their absolute value
runs high; the *difference* is the extra GPU work, which is the question.

**2. Half the ablation flags gate nothing.** `pipe.enabled` has eight keys.
Verified against `RenderPipeline.render()`:

| flag | what it actually does |
| --- | --- |
| `bloom` | gates the 6-level pyramid + 3 anamorphic streak passes — **a real pass** |
| `ssao` | gates 3 blits (AO + 2 blur) — **a real pass** |
| `taa` | gates 1 blit and the jitter — **a real pass** |
| `dof` | **inert alone.** `uEnabled = dof \|\| motionBlur`, so with `motionBlur` on the pass still runs |
| `motionBlur` | sets `uMotionScale = 0`; the pass still runs — a shader **branch** |
| `aerial` | sets `uAerialEnabled` in the prep pass, which always runs — a **branch** |
| `autoExposure` | sets `uAutoExposure` in the composite, which always runs — a **branch** |
| `fxaa` | sets `uFxaa` in a blit that always runs, **and with TAA on it is forced to 0 anyway** — a literal no-op |

`perf.js` therefore ablates *groups* that correspond to real passes
(`dofAndMotionBlurPass` turns both flags off together), labels the uniform-only
ones `…Branch`, and separately **audits** every flag by rendering with it on and
off and comparing pixel hashes. A flag whose two frames are identical is reported
`INERT` from evidence, not from someone's reading.

**3. `splitMs.sceneAndShadows` was not the scene.** Turning every flag off still
runs the prep blit, the 6-level luminance chain, the adaptation blit, the DOF
blit, the composite and the FXAA blit — six passes with no flag at all. `perf.js`
now measures the scene by rendering it into the pipeline's own HDR target with
the post chain never invoked, and reports the always-on remainder as
`ungatedPost`.

**4. It could not see play mode.** `applyShot()` forces godmode, so every frame
time ever quoted was for a mode no player runs. `perf.js` now drives
standing / walking / sprinting / combat with **dispatched keyboard and mouse
events**, and reports godmode and play side by side. It also *checks* that play
mode does anything — if holding `KeyW` for 30 frames moves nothing it says so
instead of reporting the standing frame time four times.

## GPU timer queries

A previous round shipped a probe reading 140 ms against a ~22 ms wall clock and
the number was quoted anyway. `perf.js` will only report a timer query that has
passed a **self-test**: a whole-frame `TIME_ELAPSED_EXT` query must land within
20% of the wall-clock throughput. Otherwise it reports the extension unusable and
declines to produce a number. On the ANGLE/Metal backend here it has so far never
passed, and that is the correct outcome.

## Frame reproducibility

`determinism.js` answers "if I change nothing, do I get the same frame?" For
several rounds the answer was no by rms 0.2–4.9 codes, which is larger than most
of the effects being A/B'd, so "no visual change" was unfalsifiable.

`settle()` in `main.js` already pins the pipeline frame counter (TAA jitter
phase, AO temporal rotation, grain seed) and `engine.elapsed` (wind, cloud pan,
cloud shadow). Necessary, not sufficient. Measured, two captures of one build
with a camera excursion between them:

| pinned | rms | max code | pixels differing |
| --- | --- | --- | --- |
| nothing | 5.20 | 134 | 85% |
| what `settle()` pins today | 2.53 | 108 | 33% |
| + character animation clocks | 1.10 | 42 | 28% |
| + shadow cascade refresh phase | 0.77 | 33 | 25% |
| + TAA & exposure history, 32 frames | 0.23 | 9 | 4% |

The dominant term is `src/characters/anim.js`: every `Animator` seeds `t`,
`phase` and `breath` from `Math.random()` and integrates them forever, so nine
soldiers and their cast shadows were in a different pose in every run.

`tools/shotd.mjs` now installs `window.__pinDeterminism()` into every world and
runs it immediately before every `settle()`, so **every screenshot the harness
takes** gets this. The residual (~0.2 rms, 9 codes) is the honest noise floor for
a same-build pixel diff; treat anything at or below it as "no change".

The character half of this belongs in a `resetAnimation()` on the characters
module. Until that exists the harness reaches in from outside, defensively.

## Shadow cascades

`cascades.js` produces the per-cascade draw and triangle counts by subtraction:
freeze every shadow map, render (that is the scene alone), then unfreeze exactly
one cascade and render again. No instrumentation inside three, and it cannot
drift.

The first run of it (gameplay, 1920x1080, afternoon) says the shadow pass is
**bigger than the scene it shadows**:

| | draws | triangles |
| --- | --- | --- |
| scene, shadows excluded | 242 | 2.31 M |
| cascade 0 (56 m extent, 2.7 cm texels) | 168 | 1.29 M |
| cascade 1 (162 m, 7.9 cm) | 172 | 1.33 M |
| cascade 2 (705 m, 34.4 cm) | 180 | 1.38 M |
| all three in one frame | 520 | 4.01 M |

Two things fall out of that. Each cascade draws essentially the *same* caster
set — 168 / 172 / 180 — so three's own frustum cull against the shadow camera is
rejecting almost nothing between them; the near cascade is drawing the whole
world into a 56 m box. And cascade 2 rasterises 1.38 M triangles into a map whose
texel is 34 cm, where nothing under a metre across can survive.

The amortised cost is what the refresh schedule buys: over `[1,2,4]` it was 299
shadow draws per frame, over `[1,3,6]` it is 255. Note that the >3 m camera-move
guard in `Lighting.update()` forces every cascade to refresh, so the schedule's
saving lands on standing and slow movement — which, in a stealth game, is most of
the play time — and not on a sprint.

### Which cull is worth building, from the caster inventory

`cascades.js` also inventories the casters, because a per-cascade cull can only
reject a whole `Object3D` and it is worth building only if whole objects carry
the triangles:

| | objects | triangles |
| --- | --- | --- |
| `InstancedMesh` | 124 | 668 k |
| single meshes | 29 | **712 k** |

Single meshes carry more triangles than every instanced cluster combined, and the
heaviest ten name the target exactly: three terrain clipmap rings (73 k / 55 k /
55 k, bounding diameters 1.3–1.8 km, so nothing can ever cull them) and then
**nine characters at 43–48 k triangles each and 3.2 m across**.

Those nine are ~400 k triangles drawn at full LOD into *every* cascade. In
cascade 2 a 3.2 m character is **9 texels tall**. Rasterising a 45 k-triangle
skinned mesh to produce nine texels of shadow is 29% of that cascade's triangle
count for nothing an eye can resolve.

So the cull is: **in cascade c, skip a caster whose bounding-sphere diameter is
under ~16 texels.** At cascade 2's 34.4 cm texel that threshold is 5.5 m — it
drops the characters and keeps vehicles and buildings. At cascade 1's 7.9 cm it
is 1.26 m, which keeps the characters, where they are still 40 texels tall and
plainly visible. The thresholds fall out of the texel size; there is nothing to
tune by eye.

It is **not** implemented. three renders every due shadow map inside one
`renderer.render()` call, and cascade 0 refreshes on every frame, so there is no
frame on which a `castShadow` mask could apply to one cascade and not another.
Doing it means driving the outer cascades' shadow passes explicitly —
`renderer.shadowMap.render([cascade], scene, camera)` from `Lighting.update()`
with the mask applied and `shadow.needsUpdate` left false so three's own pass
skips them. That is renderer surgery on a shared object, and shipping it
unverified at the end of a round with a four-minute measurement queue would have
been the same mistake this round exists to correct.

`casterreach.js` sweeps `Lighting.casterReach` — how far up-sun a caster can be
and still be drawn — reporting draws, triangles **and the pixel difference
against the baseline**, so a saving is never bought with a shadow that quietly
stopped being cast.
