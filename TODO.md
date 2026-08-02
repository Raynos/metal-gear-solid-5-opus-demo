# TODO

State at the end of the round-13 session. Everything here is measured, or is
marked as unverified. Where a claim reverses an earlier one it says so — this
file has now been substantially wrong three times, and every time it cost a
round.

Read `CLAUDE.md` first (rules), then `ARCHITECTURE.md` (ownership, tooling).

---

## 0. What changed this round

**The black polygons are fixed, and they were the AO pass.** So were the
mountain chevrons (round 12), the glitchy shadow dither (round 12) and the
paisley moiré (this round). Four separate defects, filed over four rounds
against four different subsystems, all owned by `src/render/RenderPipeline.js`'s
`aoMat`. If a fifth contour-following or hard-edged artefact turns up, ablate
`ssao` **first**.

| defect | cause | fix |
| --- | --- | --- |
| black polygons on the ground | `N.z < 0.0` used as "faces the camera". With a near-level camera a ground normal in view space is ~(0,1,0), so N.z sits on zero and its SIGN is decided by which way the surface happens to tilt. Half the crowned pad tilted away, the normal flipped to point INTO the ground, and the horizon integral measured the underside of the world. | `dot(N, V) < 0.0` |
| paisley moiré on the near pan | the micro term's IGN dither, printed. The blur's own comment says micro "relies on TAA and the per-frame IGN rotation for denoising" — TAA was switched off rounds ago and round 12 froze `uFrame`. A 24-tap estimator sampled once, never averaged. | fixed (deterministic) micro sample pattern, whole slice basis rebuilt on it |

Band/control on the ground shot: **0.189 → 0.905**, against 0.916 with the pass
off entirely. The sandbag seams the micro term exists for are unchanged.

**60 FPS is met in play: 15.98 ms, 62.6 FPS.** See §2 — one of the three cuts
is a resolution cut and it is visible.

**Guards no longer shoot through walls** — reported by a human playing the
build. `losClear` skipped the first 2.6 m of every sight line outright. See §4.

---

## 1. How to measure anything here, and why you must

**Six instruments have now been proved to lie on this machine.** Read this
before quoting any number. Items 1-5 are round 12's and still hold:

1. **Flipping an ablation flag stalls ~50 ms.** Charged to a single frame —
   which is what `tools/probes/perf.js` does — that is +50 ms on that frame.
   Bloom was priced at 20.05 ms this way and costs nothing measurable.
2. **This GPU downclocks under light load.** Every config must carry constant
   **ballast**; `probes/a12_ballast.js` is the working implementation.
3. **GPU timer queries are unusable on ANGLE Metal.** It billed 317.7 ms inside
   a 24 ms frame.
4. **Amplification is dead too.** An extra shadow pass over an EMPTY scene with
   zero draws cost 24.9 ms against a full 160-draw raster's 24.3.
5. **Resizing a render target at runtime to A/B a resolution** stalls harder
   than the effect being measured.
6. **NEW: running several probe invocations back to back drifts the numbers by
   25 ms.** Seven sequential `r13_pass` runs gave `none = 50.42 ms` where the
   same build measured 24.66 ms minutes earlier, ramping down to 23 ms by the
   seventh. Interleave a control, or re-measure the baseline at the END of the
   sequence and check it against the start. Two or three invocations in a row
   drift by ~0.6 ms, which is fine; seven do not.

### The measurement that works

**`probes/r13_pass.js` is the honest ablation.** The ban in item 1 is on
flipping a flag *during* a measurement. This makes the ONE state change before
the first of 48 warm frames, so the stall is absorbed by the warm-up and every
measured block is a single steady configuration. It takes:

```bash
node tools/shot.mjs eval probes/r13_pass.js ssao          # a pipeline flag
node tools/shot.mjs eval probes/r13_pass.js 0.8           # a render scale
node tools/shot.mjs eval probes/r13_pass.js hide:terrain- # a mesh or material
node tools/shot.mjs eval probes/r13_frame.js              # no ablation, 11 blocks
```

`r13_frame` reports median **and IQR** — r12_frame's 5-run median has a 6.6 ms
spread and cannot resolve a 1 ms cut. **A median that moves by less than the
IQR has not moved.**

**`probes/r13_whodraws.js` answers "which mesh draws this pixel" by ablation**,
hiding one mesh at a time and re-reading the pixel. Use it when a raycast comes
back empty — this project's merged and instanced geometry carries bounding
spheres that `intersectObjects` rejects on before testing a triangle, and four
raycasts in a row found nothing at pixels a mesh visibly occupied.

### Tools you probably do not know exist

```bash
node tools/shot.mjs film ground --out shots/x --frames 24 --every 3   # moving camera
node tools/shot.mjs film ground --hide op-cables --ablate dof         # NEW: film takes both
node tools/shot.mjs ground --hide clast,rock_chips --out shots/x      # hide meshes
node tools/shot.mjs ground --ablate ssao --out shots/x                # disable a pass
node tools/shot.mjs gameplay --aim --out shots/x                      # the AIMED view
node tools/shot.mjs status                                            # machine contention
```

**`film` never parsed `--hide` or `--ablate` until this round** — it returned
from the argument parser before the still parser saw them. So the one class of
defect that is only visible in motion was the one class "which system draws
that" could not be asked about, which is exactly how the bars sweeping the
frame stayed misfiled as perimeter wire for two rounds.

---

## 2. Performance

**Play frame: 15.98 ms, 62.6 FPS, IQR 0.62, camera moving, native 1920x1080
canvas at a 0.67 internal scale.** Was 24-25 ms / 40 FPS. Boot ~4.7 s.

Per-pass, measured with `r13_pass` at native resolution:

| item | ms | note |
| --- | --- | --- |
| terrain | ~4.6 | largest per-pixel item left |
| vegetation (grass+clast+bush+scrub) | ~3.5 | grass ~1.05, clast ~1.2 |
| AO pass | ~2.6 | was ~6.45; see cut 2 |
| outpost pad (`op-ground`) | ~1.6 | |
| bloom | below noise | 25 blits, unmeasurable |
| aerial perspective | below noise | |

**The three cuts that bought 60 FPS:**

| cut | what it was |
| --- | --- |
| motion blur **deleted** | round 12 measured it inert and left it in. It shared the DOF gather and the early-out there was conditional on zero velocity, so under a moving camera **every** pixel ran the 24-tap gather. The budget is measured with the camera moving. |
| AO broad search 8 → 5 steps | 48 of 80 depth taps, already centre-biased, ≤52 px wide, and followed by a 13-tap bilateral |
| play render scale 1.0 → **0.67** | `QUALITY.renderScale` has said since round 8 that play should lower it at runtime. `setRenderScale` **had no caller anywhere in `src/`.** |

**Why a resolution cut was unavoidable, and it is arithmetic.** The frame splits
into **~17.8 ms that scales with pixel count and ~7.4 ms that does not**
(draw submission, vertex, shadow raster, sim). Deleting every post effect in the
frame therefore cannot reach 16.7 ms.

```
1.00  25.1 ms  40 fps      0.80  18.8 ms  53 fps
0.72  17.3 ms  58 fps      0.67  16.0 ms  63 fps      0.60  14.5 ms  69 fps
```

**It is a real cost and it is visible.** 1286x723 upscaled reads softer than
native, most obviously on distant scrub. **The way to buy it back is the terrain
and ground fragment shaders — 6.2 ms between them, and the largest per-pixel
items left.** TODO's round-12 recommendation still stands: a second reduced
material compiled for the outer clipmap rings (a uniform branch does not reduce
register allocation). Every 2 ms taken out of those is ~0.05 of render scale
handed back.

**Measured and reverted, because they bought nothing:**

| cut | measured |
| --- | --- |
| shadow atlas 2048 → 1536 (44% fewer shadow texels) | 17.28 → 17.48 ms |
| `losClear` at 2 samples/cell instead of 1 | 1 line in 529 |

**Still true from round 12:** raster is close to free (86 draws and 0.7 M
triangles for 0 ms; 1.03 M frustum-rejected triangles for −0.25 ms). Draw count
and triangle count are not this frame's problem, which is why the 4.2 M
triangles against a 2.5 M budget have not been attacked. **Frame hitching**
(p99/p50 = 2.04) is still unexplained and still needs `probes/r12_hitch.js`
re-run on a quiet machine.

---

## 3. Graphics

### Fixed this round

- **The black polygons** and **the paisley moiré** — both the AO pass, see §0.

### Verified NOT present any more (looked for, not found)

- The straight-edged rectangle around the compound, the dark blotchy soil
  stains and the mid-ground LOD boundary are not visible in `outpost`, `vista`
  or `ground` at the current build. They may have been AO, or they may be below
  visibility. Re-file with a crop if you see one.
- **"Perimeter wire and mast guys sweep the frame as solid bars" was wrong.**
  Found by per-mesh ablation to be `scrub-n0` — a 2.6 m shrub 2.16 m from the
  camera, whose 3.5 cm branch legitimately spans the frame at that range. It
  does **not** happen in the play camera, which is over-the-shoulder and higher;
  it is an artefact of the harness free camera at 1.7 m eye height standing in a
  shrub field. Not fixed, deliberately: capping scrub scale is a cover cost to
  the stealth gameplay, paid to fix a camera no player uses.

### Still open

- Terrain macro tone ±8% RMS; the fix was reverted in a merge.
- `bakeVertexAO` has zero callers, and `outpost/geo.js`'s `KEEP` will silently
  delete `aAO` if anyone uses it.
- Clast receives the cascaded shadow at only ~a quarter strength, so a chip in
  shade reads 15% brighter than the shade it lies in. **This is why "the pale
  chips lying inside the black shape are still lit" was used for two rounds as
  proof the shape was not a shadow.** It was not proof of anything.

### Do not touch

The tone curve; night lighting; **sky and clouds, which beat the real game**;
aerial perspective; the HUD; the locomotion foundation.

---

## 4. Gameplay

**Reload is `R` and drag is `T`.** They were the other way round. `gp_verify`'s
MAJOR 5 reported the weapon broken for a round because it pressed R, which is
what a player would have concluded too.

**Guards shot through walls, and it was `losClear`.** Reported by a human
playing the build. Firing is gated on `guard.vis.visible` and there is **no
occlusion test anywhere downstream in `onFire`**, so a sight line that wrongly
reads clear IS a round through a wall. Scored against a real `Raycaster` over
529 guard-to-point sight lines (`probes/r13_wallshot.js`): 2.8% read clear where
the scene says blocked, 11 of those 15 stopped by `op-wall`. `NEAR_CLEAR` skips
the first 2.6 m of every ray, and the worked case is a guard 1.8 m from a wall.
The near zone is now a **height** test — an occluder above eye level blocks, one
below it does not, which is what a parapet actually is. **2.8% → 1.3%.**

**Not fixed, and measured rather than guessed at:** 6 of 529 lines still read
clear through `op-wall`. The cell dump shows `grid.top` at 0.15 where a wall
stands, so the bake under-records some wall: `stamp()` only raises `top` when a
triangle's OWN `yMin` is below `ground + OVERHEAD`, which drops the upper band
of any wall modelled as stacked courses. That is the next thing to fix here.

**Two of this file's round-12 "still open" items were already done.** Measured
in the live sim (`probes/r13_alert.js`): one shot takes the garrison CALM →
ALERT, 8 men into combat inside a second and 11 inside thirteen, commits 3
reserves, and moves the commander's post 12 m with him 19 m off the spot the
player was watching. `callReserve` is wired from `commander.js` and `harden()`
relocates the objective.

**`gp_verify` has stale assertions, not defects.** Its win-state test still
expects dropping the garrison to accomplish the mission, which exfil-only
deliberately replaced. Fix the probe before believing its FAILs.

**There was one aim pose and it was the standing one.** `_weaponTargetPose`
scales every stance carry by `base = 1 - aim`, so at full aim the stance term
went to zero and a single standing pose was all that survived — whatever the
body was doing. Reported as "the gun is floating in the air at standing
position and the hands dangle way up overhead". Measured in root space:

| stance | shoulder | head | BORE | hand |
| --- | --- | --- | --- | --- |
| stand+aim | 1.487 | 1.617 | 1.545 | 1.544 |
| crouch+aim | 1.141 | 1.263 | **1.545** | **1.539** |
| prone+aim | 0.481 | 0.604 | **1.545** | **1.067** |

`aimCrouch` and `aimProne` now hold the same relationship that makes the
standing pose read as a cheek weld — bore ~0.055 above the shoulder, ~0.07
under the head — against the bones each stance actually produces. It fixes the
garrison too: guards crouch in cover and aim from there through the same
animator. `probes/r13_stanceaim.js` measures it and photographs it.

Still open: rank thresholds are a guess nobody has played against; a guard post
is walled into a pocket the pathfinder can only reach from outside the wire; no
hip fire; no stealth verbs beyond CQC.

---

## 5. Process

- **Ablate before you read source.** `--hide` and `--ablate` have now overturned
  **eight** confident diagnoses across three sessions, including four in this
  file. A two-minute test beats an hour of reasoning about a shader.
- **Measure every candidate in ONE probe, as a ratio.** §0's six ruled-out
  causes had cost a round trip each. Re-run as one probe reporting
  band/control for every config plus a null control, the answer took one run.
- **Revert a change that measures zero**, and say in the commit that you did.
- **Judge by eye, not by statistics.** Statistics catch regressions; they do not
  set direction.
- **Never blanket-kill.** The machine is shared.

---

## 6. Honest assessment

The build no longer looks broken and it runs at 60. Both of those were true
neither at the start of this session nor at the start of the last one.

Against that:

- **60 FPS is bought partly with resolution.** 0.67 internal scale is visibly
  softer than native. It is the honest trade on this hardware for this scene,
  and it stays honest only if the next round takes it back out of the terrain
  and ground shaders rather than leaving it as the answer.
- **The AO pass has now been the root cause of four separate filed defects.**
  It is 200 lines carrying a GTAO integral, a second micro integral and a
  screen-space contact march, two of which were written expecting a temporal
  filter that has been switched off for rounds. It deserves a rewrite, not
  another patch.
- Six of 529 sight lines still see through a wall, and the cause is identified
  and unfixed.
- Nobody has played a full run and graded it. The rank thresholds are still a
  guess.
