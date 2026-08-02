# TODO

State at the end of the round-12 session. Everything here is measured or was
reported by a human playing the build. Where a claim reverses an earlier one, it
says so — this file has been substantially wrong twice, and both times it cost a
round.

Read `CLAUDE.md` first (rules), then `ARCHITECTURE.md` (ownership, tooling).

---

## 0. THE ONE THING TO FIX NEXT

**Big black polygons all over the ground.** A player sent nine screenshots of it
in one sitting with the words "game just looks broken when you try to play" and
"at certain angles everything is black". It is the most damaging defect in the
build by a wide margin and everything else in this file is secondary to it.

What it looks like: hard-edged black shapes lying on the ground — rectangles,
triangles, sawtooth bands — with pale stone chips sitting ON them, still lit.
Sometimes the whole near ground goes black as the camera turns. One screenshot
shows the same geometry from the other side as a large PALE flat slab standing
proud of the ground with wire and trees poking through it, which is the strongest
clue in the set: it is one object, and it reads black or pale depending on where
the sun is relative to its face.

**It is `outpost-pad` / `op-ground`.** `--hide outpost-pad` takes the band from
RGB 44 to 124 on the `ground` shot; `--hide terrain` leaves it at 43.9.
Owner: `src/world/outpost/`.

**What it is NOT** — each of these was tried and measured, and each failed:

| ruled out | evidence |
| --- | --- |
| a cast shadow | survives ablating the shadow term, cloud shade and AO; cascade 0's depth map is empty at those texels; a raycast up the sun finds no occluder |
| the terrain | `--hide terrain` leaves it |
| the vehicle corridor | correcting `dirt` 0.40x → the 0.70x its own comment argues for moved it 44.0 → 43.8 |
| the oil spill | floor 0.030 → 0.086 and blend 0.86 → 0.62 moved 0.2 of a code; reverted |
| the wear field at all | `uWearCtl.x = 0` moves it only 43.7 → 50.1 |
| a palette selection | with `uBase` forced white it still sits at 0.42x the sand |
| flipped normals | all 31,775 pad vertices point up; 0 down, 0 sideways, 0 degenerate |

**Two live leads, in order:**

1. **4.8% of pad vertices (1,519) have a negative N·L against the afternoon
   sun.** All normals point up, so those are steeply tilted faces — the batter
   slopes of the graded platform. A steep face turned away from a low sun gets
   only ambient, and ambient on this material is evidently not enough to keep it
   off the floor. That fits the pale-slab screenshot exactly: same geometry, lit
   side.
2. Whatever is left after that, because some of the black shapes in the
   screenshots look FLAT and level with the surrounding sand rather than steep.
   Do not assume one mechanism explains all of them.

**A trap that cost me an hour: `terrain.heightAt()` is the NATURAL heightfield,
not the graded surface.** The compound sits on a cut-and-fill platform about
33 m above it (see the note in `vegetation/Clast.js`). Measuring the pad against
`heightAt` reports a mean offset of 16.6 m and a worst case of 42.3 m, and
**none of that is a bug** — I nearly filed it as the root cause.

Reach the pad's uniforms through `material.userData.u`, **not**
`material.uniforms`. And note `uWearCtl.x` does not gate `WR.g`, while `edgeN` is
added to the corridor and foot masks outside the ablation, so that switch is not
the clean control it looks like — fix that first or you will measure the wrong
thing.

---

## 1. How to measure anything here, and why you must

**Five instruments have now been proved to lie on this machine.** Read this
before quoting any number.

1. **Flipping an ablation flag stalls ~50 ms.** Amortised over a short block that
   is +1.3 ms a frame; charged to a single frame — which is what
   `tools/probes/perf.js` does, since it flips every adjacent pair — it is
   +50 ms on that frame. That is why perf.js priced bloom at 20.05 and 20.24 ms
   on two separate runs. Bloom costs nothing measurable. **Reproducible is not
   the same as true.** Use `WARM = 64` and a **null control**: the same config
   measured twice under two names, through the same flip. `probes/r11_post.js`.
2. **This GPU downclocks under light load.** An identical scene-only config reads
   4.7 ms after a heavy block and 16.1 ms after a light one, and six extra
   fullscreen blits cost zero. Every config must carry constant **ballast**;
   `probes/a12_ballast.js` is the working implementation. This is why I reported
   the scene at 6.8 ms when it is 12.4-15.2, and AO at 2.46 ms when it is ~6.45.
3. **GPU timer queries are unusable on ANGLE Metal.** `EXT_disjoint_timer_query_webgl2`
   billed 317.7 ms inside a 24 ms frame and charged 15 ms to a 64x64 blit. Each
   query eats a command-buffer boundary, so the result scales with blit COUNT.
4. **Amplification is dead too.** Re-rastering a pass k extra times fits 7.21 ms
   per raster at r² = 0.999 — perfectly linear and entirely false, against a
   frame that loses 0.34 ms when that pass is frozen. An extra shadow pass over
   an EMPTY scene with zero draws costs 24.9 ms against a full 160-draw raster's
   24.3. It prices a render PASS, not its contents.
5. **Resizing a render target at runtime to A/B a resolution** stalls harder than
   the effect being measured (null control 3.37 ms, block spreads 33 ms).
   Compare two BUILDS instead, back to back in one sitting —
   `probes/r12_frame.js` measures one config with no flips and no resizes.

**Absolute times are only comparable within one session.** The same build
measured 29.5 ms and 39.8 ms hours apart. `node tools/shot.mjs status` reports
headless chromium count, vite count, load average and which other worktrees are
running — check it before every timing run and say what it said.

**A green probe proves nothing by itself.** This session's end-card check passed
for the wrong reason (matched `RANK` anywhere in `#ui` with the menu still
mounted), then failed for the wrong reason (`RANK` + value `S` renders as
"RANKS", so `\bRANK\b` misses a working card). Scope the assertion and look at
what it actually matched.

### Tools you probably do not know exist

```bash
node tools/shot.mjs film ground --out shots/x --frames 24 --every 3   # moving camera
node tools/shot.mjs ground --hide clast,rock_chips --out shots/x      # hide meshes
node tools/shot.mjs ground --ablate ssao --out shots/x                # disable a pass
node tools/shot.mjs gameplay --cinematic --out shots/x                # play-mode post (DOF)
node tools/shot.mjs gameplay --aim --out shots/x                      # the AIMED view
node tools/shot.mjs status                                            # machine contention
```

`--hide` and `--ablate` have between them overturned **five** confident
diagnoses in two sessions, including three of mine. Reach for them before
reading source. `film` is not optional for anything temporal: every defect a
human has ever complained about here was invisible in a static pose.

**The vista shot was never reproducible until this session.** `index.html`'s
`#boot` overlay fades over 420 ms and was never removed from the DOM, so the
FIRST screenshot of every run composited a black veil of unknown opacity —
154.1 / 133.1 / 146.7 across runs of identical source. Now 158.0 / 158.0 / 158.0
across 1-, 3- and 7-shot batches. **Any vista measurement quoted from rounds
1-11 has an unknown veil under it.**

---

## 2. Performance

Frame is **~24 ms** at native 1920x1080 in play with the camera moving (~42 FPS).
Boot is **~4.8-5.0 s**. GPU-bound: sim CPU is 0.2 ms.

| pass | ms | note |
| --- | --- | --- |
| **scene into HDR** | **12.4-15.2** | ~6.1 per-pixel shading, ~1.75 shadow re-raster, ~5-7 vertex/draw |
| — of which terrain fragment body | **2.67** | the largest single thing left |
| AO pass | **~6.45** | measured with ballast; the largest post item |
| DOF + motion blur | 2.5-3.3 | |
| volumetrics | ~2.5 | cumulus march 1.68, its light march 0.89 |
| bloom | 0.8-1.7 | |
| composite / present / prep / luminance chain | ~1.5-2 combined | no flags; not worth chasing |

**Cuts tried this session, all measured:**

| cut | predicted | measured | verdict |
| --- | --- | --- | --- |
| half-res DOF gather | 2-2.5 ms | **0.2-0.4 ms** | kept — free, but not a win |
| broad-AO distance fade | — | **0.2-0.5 ms** | kept — and it fixed the mountains, see §3 |
| half-res AO | 1.5 ms | **~2 ms** | **REVERTED** — costs the contact band |
| cascade 0 every 2 frames | 0.9 ms | **0 ms** | reverted; 86 draws saved, no time |
| quarter-res volumetric march | 0.8 ms | unconfirmed | rejected — 9-18% cloud contrast |
| tiling clutter for frustum rejection | — | **−0.25 ms** | reverted; blew the draw budget for nothing |

**Half-res AO works and was reverted on purpose.** Cropping the sandbag wall at
1:1 shows what the pass comments predict: at full res the seams between bags are
clearly darker and the bags read as separate objects; at half res they soften
and the wall flattens into one mass. Contact occlusion was round 9's entire
deliverable. 24 → 22 ms is 45 FPS, not 60, so trading seated geometry for 8% of
a frame is a decision for whoever owns the look. **The correct version is a
half-res BROAD term with a full-res micro and contact term** — the broad horizon
search is 24 taps and inherently low frequency; micro is 12 and the contact
march 8. That is the largest well-understood job left in the pipeline.

**Is 16.7 ms reachable? Not by post-chain work alone, and that is arithmetic.**
Post in its entirety is ~10-11 ms, so deleting every effect still leaves ~15-16
ms of scene. Reaching 60 needs 2-3 ms out of the scene render as well — which
means the terrain fragment body, and that needs a second reduced material
compiled for the outer clipmap rings (a uniform branch does not reduce register
allocation; this shader's occupancy is paid on every terrain pixel either way).

**Raster is close to free here.** Two independent results say so: the cascade cut
removed 86 draws and 0.7 M triangles for 0 ms, and tiling the clutter removed
1.03 M frustum-rejected triangles for −0.25 ms. **The audit's "5-7 ms of vertex,
draw and raster" is the next number to distrust.** Draw count and triangle count
are not this frame's problem.

**Frame hitching is reported and not explained.** p99/p50 = 2.04 on a walk
through the compound. Four causes eliminated: not worse in the middle of camp
(p50 flat 50-58 ms at every distance), not periodic with the cascade schedule,
not correlated with draw calls, and not lazy shader compilation (0 programs and
0 textures compiled across the whole walk). Most likely remaining explanation is
that the measuring machine had other agents on it. **Re-run `probes/r12_hitch.js`
on a quiet machine before acting on it.**

`motionBlur` is **inert** — rms 0.103 against a 0.224 liveness threshold.

---

## 3. Graphics

### Fixed this session

- **Mountain chevron/herringbone banding — was the AO pass, not the terrain.**
  This file blamed the Jacobi thermal pass, the droplet brush and `_smoothFlats`'
  25° slope gate for two rounds. Six full re-bakes with the erosion stack off
  changed nothing, and a Lambert hillshade of the heightfield shows a clean
  mountain. The mechanism: `pixRadius = clamp(uRadius * pixPerMetre, 3.0, 52.0)`
  — at a kilometre the 1.15 m radius projects to ~1 px and is clamped UP to 3,
  so the horizon search measures depth quantisation instead of occlusion, which
  is why the pattern follows the contours. Fixed by fading the broad term over
  the same range the micro term already faded over. High-pass RMS 1.110 → 0.835
  against 0.806 for AO off entirely.
- **Glitchy shadows and blacks — was AO dithering with no temporal resolve.**
  GTAO rotates its slice dither per pixel AND per frame expecting TAA to average
  it; TAA was switched off for FXAA rounds ago and nobody revisited the passes
  that depended on it. Camera static, dt = 0, where a stable renderer reads
  0.000: 2.423 shipped, 0.164 with grain and AO off, and **no change at all**
  with the shadow map off. Frozen while TAA is off; AO now contributes zero.
  What remains is film grain, which is meant to animate.
- Shadows lifted (`dayKeyFill` 8.6:1 was a clear-sky ratio on a dusty sky; now
  1.6/5.5). Ground clutter (the plates by the sandbags were `bush-n1` from
  `Scrub.js`, not rocks; clast chips read cool, had a waterline normalised by
  radius, were squashed twice into 20:1, and had 35% more sky than the terrain).

### Still open

- **§0 above.** Everything else is secondary.
- **Paisley moiré on the near pan.** Still there and still unexplained — the
  player's screenshots show it clearly. 2x supersampling makes it SHARPER, which
  rules out sampling-rate aliasing. Standing hypothesis is grazing-angle
  specular; there is **no specular anti-aliasing anywhere in `src/`**, and
  `18da009` dropped the `gRough` clamp floor 0.55 → 0.30 on exactly the near-flat
  pan the defect lives on. **Now also worth testing against the AO pass**, which
  has just explained two other contour-following artefacts.
- Dark blotchy stains on open ground. `uSoilD` (0.62x over ~14% of the ground)
  landed after the defect was filed and is a literal description of it;
  `uDbg3.x` ablates the whole soil-class layer in one uniform.
- Terrain macro tone ±8% RMS; the fix was reverted in a merge and the line is
  character-for-character what it was when the complaint was filed.
- Visible LOD boundary across the mid-ground (no geomorph between clipmap
  levels; boundaries at 24/48/96/192 m).
- A straight-edged rectangle around the compound: the traffic wear-map fetch is
  gated by a binary in-bounds test with no fade.
- Perimeter wire and mast guys sweep across the whole frame as solid bars at eye
  height. Only visible in motion.
- `bakeVertexAO` has zero callers, and `outpost/geo.js`'s `KEEP` will silently
  delete `aAO` if anyone uses it.
- Clast receives the cascaded shadow at only ~a quarter strength (ablating the
  shadow term brightens shaded ground +40.3 codes and shaded clast +9.3), so a
  chip in shade reads 15% brighter than the shade it lies in.

### Do not touch

The tone curve; night lighting; **sky and clouds, which beat the real game**;
aerial perspective; the HUD; the locomotion foundation (37 consecutive frames at
0.000000 m foot drift).

---

## 4. Gameplay

**The mission has a shape.** Infiltrate the real perimeter polygon (the old flat
46 m ring was outside the wire on 39 of 72 bearings), neutralise the commander,
and **exfil** — the only win. Killing him from outside and standing still no
longer ends it. Runs graded S/A/B/C on the end card.

**Aiming was rebuilt and it was badly broken.** The weapon never shot where you
looked: the ray started at the eye but used the CAMERA's forward vector, and
those lines are parallel, so 1.87-1.94 m of lateral error at every range. Fixed
to 0.00-0.03 m. Then the LOOK of it: the rig was 10.9° off the shot line, 9 of
11 points along the barrel were behind the player's own body, **the autofocus
was metering on his shoulder** so the sharp thing in an aimed frame was a camo
sleeve at 1.6 m, and ADS was a 1.36x zoom (now 2.13x; a head at 25 m is 24.5 px
instead of 16.0). The reticle was never missing — it was a near-white stroke on
same-luminance sand.

Also fixed: guards walked at **1/6 speed** because `Guard.apply` never set
`ch.desiredYaw`; exactly one commander now (the garrison was promoting a
perimeter sentry to the full rank loadout while the real objective stood inside
wearing nothing); the takedown clip plays on the player; sentries relieve each
other (8/12 moving in 20 s, was 3).

Still open: alerts do nothing to the reserve or to patrol routes; rank thresholds
are a guess nobody has played against; a guard post is walled into a pocket the
pathfinder can only reach from outside the wire; no hip fire; no stealth verbs
beyond CQC.

---

## 5. Process

- **Use steerable subagents, not `Workflow`.** They can be corrected mid-flight;
  workflows cannot. One agent died to an API error this session and was resumed
  from its transcript with its worktree intact — commit early on a branch so
  that is cheap.
- **Base every worktree on current `main` and re-verify after each merge.**
- **Never blanket-kill.** An orphan is reparented to init; another author's live
  process still has a live parent.
- **Delete rather than fix forward.** The corridor `dirt` term went from doing
  nothing (ratio 1.00) straight past its 0.7x target to 0.40x while being fixed.
- **Revert a change that measures zero.** Two cuts this session removed real work
  (86 draws; 1.03 M triangles) for no measurable time and were reverted, because
  a change that buys nothing cannot justify any risk.
- **Judge by eye, not by statistics.** Statistics catch regressions; they do not
  set direction.

---

## 6. Honest assessment

The instruments can now be trusted, which is the main thing that changed. The
establishing shot is reproducible for the first time, ablation numbers have null
controls under them, "which system draws that" is a nine-second question, and
the aimed view can be photographed at all.

Against that: **a player who sat down to play it sent nine screenshots of black
polygons and said it looks broken.** Nothing in §2 or §3 matters until §0 is
fixed. The frame is 42 FPS against a 60 FPS target and the remaining path to 60
runs through the terrain shader, not the post chain.

Five confident diagnoses in this file have been overturned by a two-minute
`--hide` or `--ablate` test in the last two sessions. Assume more of what is
written above is wrong, and reach for those tools before reading source.
