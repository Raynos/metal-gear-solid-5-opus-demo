# TODO

State as of the end of the round-11 session. Everything here is either measured
or was reported by a human playing the build — nothing is speculative.

Read `CLAUDE.md` first (rules), then `ARCHITECTURE.md` (ownership, tooling).

**The round-9 version of this file was substantially wrong**, and following it
verbatim would have wasted most of round 11. Six of its gameplay/character
claims were already fixed, eight of its thirteen graphics defects had had no
code written against them, and its performance section pointed at the wrong half
of the frame. Where a claim below reverses an earlier one, it says so.

---

## 0. How to measure anything here, and why you must

Every performance number in this project has been wrong at least once, and round
11 added two new ways to be wrong. Read this before quoting any figure.

**Flipping an ablation flag stalls for ~50 ms.** Amortised over a short block
that is +1.3 ms a frame; charged to a single frame — which is what
`tools/probes/perf.js`'s adjacent-frame pairing does, since it flips every pair
— it is +50 ms on that frame. This is why perf.js priced bloom at 20.05 and
20.24 ms on two separate runs. Bloom costs nothing measurable: with no toggle
between blocks, on 24.73 ms against off 25.47 ms, spreads 0.84 and 0.94.
**Reproducible is not the same as true.** Use `WARM = 64` frames and a **null
control** — the same configuration measured twice under two names, through the
same flip. Nothing smaller than the control is real. See `probes/r11_post.js`.

**Absolute frame times are only comparable within one session.** The same build
measured 29.5-30.0 ms early in the round and 37.5-39.8 ms later the same day.
Any before/after must be run back to back, in one sitting. `probes/results/
r11-perf-ab-pre.json` and `-ab-head.json` are such a pair.

**Amplification does not work on this platform, and it is the fourth dead
instrument.** The obvious way to measure something too small to see is to do it
k times and fit a slope. Wrapping `renderer.shadowMap.render` and re-rasterising
cascade 0 k extra times gave 7.21 ms per raster with r² = 0.999 — a beautiful
straight line, and impossible, since it puts 7.2 ms of cascade 0 inside a 25.3 ms
frame that only loses 0.34 ms when cascade 0 is frozen. The arbitration is in
`probes/r12_shadowcost.js`: an extra shadow pass over an EMPTY scene, zero
draws in it, costs 24.9 ms against a full 160-draw raster's 24.3 ms. What the
amplifier prices is a render PASS, not the work inside it — the same
command-buffer-boundary pathology that made GPU timer queries unusable here.
Extra passes on this GPU cost about 20-25 ms each regardless of contents.

**Prefer PAIRED differences over differences of medians.** Every earlier probe
here differenced two configs' medians, which throws the pairing away and lets
slow drift in as noise. Difference config A and config B *within each rep*, then
take the median and the SIGN TEST over reps: a real effect is positive in nearly
every rep (the AO pass, 6/6), a non-effect is positive in about half (the
cascade schedule, 3/6). On a shared machine that is the difference between a
result and a coin flip.

**`node tools/shot.mjs status` says "quiet" when it is not.** It trips on
>4 headless procs or load >0.7×cores. Sitting under both, the same probe on the
same source measured 25 ms and 49 ms two hours apart, and another author's
browser can double a frame time without moving either number. Take an absolute
frame time from it as a factor-of-two figure and rely on within-run controls.

**`node tools/shot.mjs status`** reports headless chromium count, vite count,
load average against core count and which other worktrees are running. Check it
before timing anything and say what it said.

**The vista shot was never reproducible until now**, and nobody noticed for ten
rounds. `index.html`'s `#boot` overlay fades over 420 ms and is never removed
from the DOM, so the FIRST screenshot of every run composited a black veil of
unknown opacity — 154.1 / 133.1 / 146.7 across runs of identical source, always
dimmer, never brighter. `tools/render.mjs` removes it now: 158.0 / 158.0 / 158.0
across 1-, 3- and 7-shot batches. **Any vista measurement quoted from rounds 1-10
has an unknown veil under it.** It bit the establishing frames hardest because
they are the ones shot first.

**Verify in motion.** `node tools/shot.mjs film ground --out shots/x --frames 24
--every 3` trucks and pans, and deliberately does not re-pin per frame so
temporal artefacts are visible. Every defect a human ever complained about here
was invisible in a static pose.

**`node tools/shot.mjs <shot> --hide <substring>`** shoots with matching meshes
hidden. This is how you answer "which system draws that", and it has now
overturned four confident diagnoses in one round. Doing it statistically from
inside the page does not work — hiding meshes perturbs AO and the volumetric
history, so a baseline-against-baseline control still shows 12% of the ground
band changed.

---

## 1. Performance

**The frame is GPU-bound and the scene render is the biggest item in it.**
Sim CPU is 0.2 ms; render submit blocks ~26 ms on back-pressure.

An independent audit re-measured this and **my round-11 numbers below the line
were wrong by about 2x on the largest item.** Three instruments had to be fixed
before any figure could be trusted, and all three are worth knowing about:

- **GPU timer queries are unusable on ANGLE Metal.** `EXT_disjoint_timer_query_webgl2`
  billed 317.7 ms of "GPU" inside a 24 ms frame, and a 64x64 luminance blit read
  15 ms. Each query eats a command-buffer boundary, so results scale with blit
  COUNT, not work. This is almost certainly the historical "timer query 6x off".
- **The M3 Pro's power governor invalidates any light-config measurement.** An
  identical scene-only config read 4.7 ms after a heavy block and 16.1 ms after
  a light one, and six extra fullscreen blits cost zero. Fix: give every config
  constant **ballast** (extra fullscreen blits) so clock state cancels in the
  differences. `probes/a12_ballast.js`. **This is why my 6.8-8.8 ms figure for
  the scene was half the truth** — it was measured on a light config, at
  governor speed.
- **`setRenderScale` plus skipped passes poisons the raster with NaN.**
  Reallocation leaves uninitialised half-float targets and the in-scene
  volumetric quad samples them with blending. Clear every target on config change.

| pass | ms | note |
| --- | --- | --- |
| **scene into HDR, total** | **12.4-15.2** | ~6.1 per-pixel shading, 1.75 shadow re-raster, ~5-7 vertex/draw |
| DOF + motion blur | 2.5-3.3 | measured three ways; I had said 0.89 |
| AO pass | 2.2-2.9 | — |
| volumetric blits | 1.5-1.9 | plus 0.6 for the in-scene quad and particles |
| bloom | 0.8-1.7 | I had said below noise; wrong at the top of the band |
| composite | 0.5-0.7 | — |
| present/FXAA, prep, luminance chain | ~1 combined | — |

**The "~12 ms hides in the unflagged passes" theory is dead.** Those five passes
total ~1.5-2 ms. The missing time was the scene itself.

**Round-12 corrections to the table above, all measured with ballast:**

- **The AO pass is ~6.45 ms, not 2.2-2.9.** Seen in 6 of 6 reps as a positive
  control while measuring something else. My earlier 2.46 ms was measured
  WITHOUT ballast, and that is the governor effect in miniature: ablating AO
  drops the load, the GPU downclocks, and the saving under-reads. **AO is now
  the largest single post item and the biggest remaining lever** — a half-res
  broad term with a full-res contact term is worth ~3 ms. The cost is the 2-3
  pixel contact band the pass comments defend, which was round 9's headline
  deliverable, so this needs a visual verdict as well as a number.
- **Shadow cascade re-rasterisation is NOT 1.75 ms.** Putting cascade 0 on a
  2-frame schedule removes 86 draws and 0.7 M triangles a frame (469.6 -> 383.5
  draws, 18%) and moves the frame by 0.30 / -0.25 ms against null controls of
  0.01 and 0.79 — i.e. nothing. Depth-only raster is close to free on this GPU.
  The cut is KEPT for the draw budget (ARCHITECTURE asks < 350), explicitly not
  for milliseconds. Visual cost in motion: stale frames differ by 0.18-0.23
  codes mean where two consecutive frames of the same film differ by 9.08, so
  ~2.5% of what the image is doing anyway.
- **Quarter-resolution volumetric march: REJECTED.** It costs 9-18% of local
  contrast at every scale from 2 to 64 px against a null control of 0.00, and
  small cumulus visibly lose their turrets. The saving could not even be
  confirmed. Section 2.10 says the sky beats the real game; it is not for sale
  at that price. Reprojection and the depth-aware upsample DO hold at quarter
  res (frame-to-frame 5.36 vs half's 5.48), so the mechanism is fine — the
  resolution is not.

**A fourth instrument is dead: shadow-pass amplification.** Re-rastering cascade
0 k extra times and fitting the slope gives 7.21 ms per raster at r-squared
0.999 — beautifully linear and completely false, against a frame that loses
0.34 ms when cascade 0 is frozen outright. An extra shadow pass over an EMPTY
scene with zero draws costs 24.9 ms against a full 160-draw raster's 24.3. It
prices a render PASS, not its contents — the same command-buffer pathology as
the GPU timer queries. Do not amplify to measure on this backend.

**Correction to 2.1's clast evidence.** "Clast does not receive the cascaded
shadow at all" is too strong. Ablating the shadow term brightens shaded ground
by +40.3 to +42.5 codes and shaded clast by only +9.3 to +12.2 — so clast does
receive it, at roughly a quarter strength, and a chip in shade still reads 15%
brighter than the shade it lies in (94.5 against 81.8). The CONCLUSION in 2.1
stands — chips are worthless as evidence about whether a shadow is present —
but its mechanism was wrong. The sun-gated ground bounce is ruled out
(zeroing `uAmbBounce` moves shaded clast -0.24). Remaining candidates: the
flat-shaded facet normals, and the chips' albedo / envMapIntensity.

**Ranked cuts, with expected savings:**
1. DOF/MB gather at half res — ~2-2.5 ms. **Done**, see below.
2. Scene shading + geometry — ~2-3 ms available, never optimised because
   everyone believed it was 7 ms total. Needs its own round.
3. AO at half res with depth-aware upsample — ~1.5 ms, costs the 2-3 px contact band.
4. Shadow cascades on alternate frames — **done, and the ~0.9 ms is not there.**
   Cascade 0 now refreshes every other frame (`refreshInterval[0] = 2`), which
   takes 86 draws and 0.7 M triangles a frame off the frame — 18% of all draws,
   469.6 → 383.5. The frame TIME does not move: 0.30 ms median against a 0.01 ms
   null control on one run and −0.25 ms against 0.79 on another, while the same
   instrument saw the AO pass in 6 reps out of 6. Freezing cascade 0 outright
   (160 draws, 1.4 M triangles, every frame) moved the median 25.20 → 24.86.
   Depth-only raster is close to free on this GPU; the 1.75 ms in the table
   above has never been isolated from the schedule side and should be treated
   as unconfirmed. Kept for the draw budget, not for milliseconds; reverting is
   `refreshInterval[0] = 1`. `probes/r12_cascade.js`.
5. Volumetric march half to quarter res — **measured and REJECTED.** It costs
   12-18% of the cloud deck's local contrast at every scale from 2 to 32 px
   (sky box, vista: 1.52/1.80/2.88/4.87/7.24 → 1.33/1.56/2.36/4.12/6.61) against
   a null control of 0.00 between two half-res builds, and by eye the small
   cumulus lose their turrets and go blocky. It does NOT crawl or ghost — the
   frame-to-frame change under a moving camera is 5.36 against half res's 5.48,
   i.e. slightly quieter, because the image is simply softer. The saving could
   not be resolved on a contended machine: 1.44 ms median paired, 4/8 reps
   positive, against a null control that was itself 2.79. Section 2.10 says the
   sky is the one thing here that beats the real game; this trades it for a
   number the instrument cannot even confirm. `probes/r12_volres.js`, which can
   A/B the resolution inside ONE page via `VolumetricPass.setMarchDiv`.
6. Fuse composite + present — only ~0.4-0.5 ms. Feeding the luminance chain from
   a bloom mip is worth nothing: the whole chain is 0.3 ms.

**Round-12 cut results, measured on a quiet machine (load 4.77, status said
"quiet"), two runs each, back to back in one sitting:**

| cut | measured | verdict |
| --- | --- | --- |
| half-res DOF gather | **0.2-0.4 ms**, inside the spread | kept — it is free, but it is not a win |
| half-res AO | **~2 ms** | REVERTED — costs the contact band |
| cascade 0 every 2 frames | 0.30 / -0.25 ms vs controls 0.01 / 0.79 | reverted; 86 draws saved, no time |
| quarter-res volumetric march | unconfirmed | rejected — 9-18% cloud contrast |

    half-res DOF   median 24.29 / 24.78   min 18.07 / 18.07
    full-res DOF   median 25.13 / 24.82   min 18.32 / 18.23
    half-res AO    median 22.34           min 17.04

DOF disappointed because the gather early-outs to ONE tap for any in-focus
pixel, and most of the frame is in focus — halving resolution only halves the
gather for the defocused minority. The audit's 2.5-3.3 ms for that pass is
presumably mostly its always-run full-resolution blit, which half res does not
remove.

**Half-res AO works and was reverted on purpose.** Cropping the sandbag wall on
`ground` at 1:1 shows what the pass comments predict: at full res the seams
between bags are clearly darker and the bags read as separate objects; at half
res the seams soften and the wall flattens toward one mass. Contact occlusion
was round 9's entire deliverable, and section 6 says the weakest thing about
this game's look is that nothing is seated. 2 ms does not reach 60 FPS on its
own (24 -> 22 ms is 45 FPS), so trading seated geometry for 8% of a frame is a
decision for whoever owns the look, not something to slip into a perf pass.

**The correct version of that cut is a half-res BROAD term with a full-res micro
and contact term.** The broad GTAO horizon search is 3 slices x 8 steps = 24 taps
and is inherently low frequency; the micro search is 12 taps and the contact
march 8, and those are the fine ones. Splitting them should keep the band and
still take most of the 2 ms. It is a shader restructure into two passes and it
is the largest well-understood piece of work left in the pipeline.

**Is 16.7 ms at native reachable? Not by post-chain work alone, and that is
arithmetic.** Post in its entirety is ~10-11 ms, so deleting every effect except
composite and present still leaves ~15-16 ms of scene — at budget with nothing
switched on. Cuts 1+3+4+5+6 total ~6-7 ms and land at ~18-19 ms (53-55 FPS).
Reaching 60 needs 2-3 ms out of the scene render as well. If the scene is
untouchable the honest answer is no; the cheapest visible sacrifices per
millisecond are DOF resolution (barely visible), then AO resolution (visible up
close), then volumetric resolution.

Near 16.7 ms the governor begins downclocking, so savings will **not** stack
linearly. Measure every cut back to back with ballast, never a light config bare.

**Cut 1 is landed.** The DOF/motion-blur gather runs at half resolution and the
composite blends it by an alpha the pass writes (0 on its early-out, 1 where it
actually gathered), so the full-resolution sharp read survives everywhere the
pass did nothing. Verified with a positive control: forcing the blend to 1
drops in-focus high-frequency energy 47%, while the shipped path drops 0.9%.
**The saving itself is NOT yet measured** — every attempt landed on a contended
machine (block spreads 12-26 ms against a 3.4 ms null control) and resizing the
target at runtime to A/B it stalls worse than the effect. Measure it on a quiet
machine with `probes/r12_frame.js`, run on both builds back to back.

`motionBlur` is **inert** — rms 0.103 against a 0.224 liveness threshold.

---

## 2. Graphics — what is actually open

### 2.1 The black band on the outpost yard — OPEN, and four fixes have missed
Reads RGB 44 against sunlit sand at 180 (0.24x) over a yard-sized area.

**It is not a shadow.** Round 9's TODO called it "hard-edged black shadow blobs
— CONFIRMED shadow map" and blamed cascade texel size plus a dithered PCF
boundary. It survives ablating the shadow term, the cloud shade and the AO;
cascade 0's depth map is empty at those pixels; a raycast up the sun finds no
occluder.

**It is `outpost-pad` / `op-ground`** — `--hide op-ground` takes it 44 → 124,
`--hide terrain` leaves it at 43.9. Owner: `src/world/outpost/`.

What it is *not*, all measured this round: not the vehicle corridor (correcting
`dirt` from 0.40x to the 0.70x its own comment argues for moved it 44.0 → 43.8);
not the oil spill (floor 0.030 → 0.086 and blend 0.86 → 0.62 moved 0.2 of a
code, and was reverted); not the wear field at all (`uWearCtl.x = 0` moves it
only 43.7 → 50.1); not a palette selection (with `uBase` forced white it still
sits at 0.42x the sand).

Reach the uniforms through `material.userData.u`, **not** `material.uniforms`.
And note `uWearCtl.x` does not gate `WR.g`, while `edgeN` is added to the
corridor and foot masks outside the ablation — so that switch is not the clean
control it looks like. Fix that first or you will measure the wrong thing.

**Start by re-testing the shadow hypothesis, which was retired on void
evidence.** The strongest argument for "not a shadow" was that the pale stone
chips lying *inside* the band are as bright as the ones outside it. That
argument is worthless — but **not for the reason round 11 gave**. The claim was
that clast does not receive the cascaded shadow at all (`csmSunVis` = 1.0 over
every clast fragment). Measured from outside the shader, that is too strong:
ablating the shadow term (`shadow.intensity = 0`, a uniform, so nothing
recompiles) brightens shaded clast by 9.3-12.2 codes, so it does receive one.
What is real is that the SAME shadow brightens the ground the stones lie on by
40.3-42.5 codes — clast responds at about a quarter of the ground's magnitude —
and a shaded chip ends up reading 94.5 against the shaded sand's 81.8, i.e. 15%
BRIGHTER than the shade it is lying in. So chips inside the band really are as
bright as the ones outside, and really do tell you nothing about whether a
shadow is there. The sun-gated ground bounce is NOT the cause (zeroing
`uAmbBounce` moves shaded clast by −0.24 codes and shaded ground by −1.27, i.e.
neither is taking it, which is the correct behaviour and kills the obvious
hypothesis). The remaining candidates are the flat-shaded facet normals — a
random flake facet has a much smaller N·L than the flat ground, so there is less
direct light for a shadow to remove — and the chips' own albedo and
`envMapIntensity` making ambient a larger share of what they return.
`probes/r12_clastshadow.js` re-runs the whole thing in one command. Owner:
`src/world/vegetation/Clast.js`. Cropped close (`shots/crop-road.png`) the band has hard straight edges,
sharp vertices and a chevron notch — geometry-shaped, which fits a cast shadow
at least as well as a mask. The other two arguments (an empty cascade-0 depth
map at those texels, a raycast up the sun finding no occluder) are stronger and
may still hold, but they were taken with instruments that have been wrong here
before, so re-run them before believing them. Fix the clast shadow-receive bug
first; it may make the whole question answer itself.

### 2.2 Paisley moiré on the ground — OPEN, never chased
The "distorted" complaint. **2x supersampling makes it SHARPER**, which rules out
sampling-rate aliasing outright. Every terrain material layer off, detail albedo
flat, all normal perturbation forced to the baked normal, baked-normal anisotropy
16 → 1, SSAO/DOF/TAA/aerial each off: still there. Shadow map off drops its
contrast ~40% and does not remove it.

Leading hypothesis, still untested in code: **grazing-angle specular**. There is
**no specular anti-aliasing anywhere in `src/`** — no Toksvig, no normal-variance
to roughness. And `18da009` made it worse: the `gRough` clamp floor went
**0.55 → 0.30** for oil-spill legibility, on the exact near-flat pan the defect
lives on. Re-clamp per-term, then add specular AA. Owner: `src/world/Terrain.js`.

Do NOT chase "the specular is broken" — those shaders overwrite `roughnessFactor`
unconditionally, so setting `material.roughness` from a probe ablates nothing.

### 2.3 Chevron/herringbone on distant mountains — OPEN, lead identified
`Terrain.js` documents that the Jacobi thermal pass and the cone droplet brush
both leave a herringbone at the grid cell, and `_smoothFlats` exists to remove
it — but it is gated to low slope, `w = (1 - smoothstep(0.11, 0.52, slope))`, so
above ~25° the herringbone is **left in by design**. Mountains are steeper
than 25°.

### 2.4 Dark blotchy stains on open ground — OPEN, new candidate
`18da009` landed after the defect was filed and added `uSoilD = (0.620, 0.545,
0.470)` — a 0.62x darkening over ~14% of the ground, selected by a 236/79/24 m
noise field. That is a literal description of the defect. `uDbg3.x` ablates the
whole soil-class layer in one uniform; start there.

### 2.5 Terrain macro tone — OPEN, and the fix was reverted in a merge
±8% RMS against a source comment claiming 1.46 stops. `18da009` claimed a 1.36x
coefficient lift; the merge `6638af5` explicitly discarded it, and the line is
character-for-character what it was when the complaint was filed.

### 2.6 Visible LOD boundary across the mid-ground — OPEN, structural
No geomorph between clipmap levels. Level boundaries sit at 24 / 48 / 96 / 192 m;
`_ringGeometry` only does odd-vertex stitching, which prevents cracks, not a
detail discontinuity.

### 2.7 Mountains read as repeating spiky cones — OPEN, instrumentation still not done
The erosion and talus passes DO run on the far grid. Round 9 was asked to
instrument whether they change the pixels the vista and ridge cameras actually
see, and did not. Still nobody has. Do that before touching the generator.

### 2.8 Unreported until now
- **A straight-edged rectangle around the compound.** `Terrain.js` gates the
  traffic wear-map fetch with a binary in-bounds test and no fade, driving up to
  a 0.92 albedo mix, so the ground tone steps along the field's footprint.
- **Perimeter wire and mast guys sweep across the entire frame as solid bars**
  once the camera moves a few metres at eye height. Only visible in motion.
- **`bakeVertexAO` has zero callers**, and `outpost/geo.js`'s `KEEP` list will
  silently delete `aAO` if anyone uses it — reproducing the exact bug that
  disabled the palette selector for two rounds. Wire it or delete it.

### 2.9 Fixed this round
Shadows lifted (`dayKeyFill` 8.6:1 was a clear-sky ratio on a dusty sky; now
1.6/5.5, noon 3.07 → 2.43 stops, hue unmoved, clipping bit-identical, night
unregressed). Ground clutter: the plates by the sandbags were **`bush-n1` from
`Scrub.js`** — nine ribbons scaled into a 0.25 x 1.96 m double-sided plank — not
rocks and not clast; the clast chips read cool (R/B 1.15 against sand at 1.43),
had a waterline normalised by radius instead of emergent height, were squashed
twice into 20:1, and had 35% *more* sky than the terrain they lie on.

### 2.10 Do not touch
The tone curve; night lighting; **sky and clouds, which beat the real game**;
aerial perspective across kilometres; shadow penumbra growth with occluder
distance; the HUD; the locomotion foundation (re-verified this round: 37
consecutive frames at 0.000000 m foot drift).

---

## 3. Gameplay

**The mission has a shape now.** Verified end to end by `probes/r11_mission.js`:
infiltrate inside the actual perimeter polygon (the old flat 46 m ring was
*outside* the wire on 39 of 72 bearings), neutralise the commander, and **exfil**
— which is the only win. Killing him from outside and standing still no longer
ends the mission; walking away at the start does not either. Runs are graded
S/A/B/C on never-seen / alerts / clock and the end card draws it.

Fixed this round: exactly one commander (the garrison was promoting a perimeter
sentry to the full rank loadout while the real objective stood inside wearing
nothing); guards were walking at **1/6 speed** because `Guard.apply` never set
`ch.desiredYaw`; sentries now relieve each other (8/12 moving in 20 s, was 3);
the commander re-posts and takes bodyguards when the compound goes loud; the
takedown clip plays on the player (it was authored and nothing called it, so the
victim animated while the player stood frozen).

Still open:
- Alerts do nothing to the reserve or to patrol routes.
- Rank thresholds are a guess — nobody has played a run against them.
- A guard post is walled into a pocket the pathfinder can only reach from
  outside the wire (`registry.ai.isolatedPosts` reports it). Outpost layout.
- No stealth verbs beyond CQC: no hold-up, no interrogation, no Fulton.

---

## 4. Characters

Model and animation both improved this round. The weapon now hangs off the chest
joint rather than the actor root, so the gait reaches the hands: run travel
11.4 → 22.5 cm on the firing hand and 33.9 cm on the support hand, with
hand-vs-head height correlation 0.988 → 0.620. The rifle has the suppressor
`WEAPON.suppressed` had claimed all along, plus ejection port, brass deflector,
selector, bolt catch and rear sight.

Still open:
- Two-handed run travel tops out at 22.5 cm against a 30-50 cm target, and the
  reason is measured: the arm starts at ~95% reach, so every centimetre of
  weapon swing is absorbed. It is met only once the support hand releases.
- 13 characters still share one silhouette; height varies, build does not.
- No facial features at conversational range.

---

## 5. Process

- **Use steerable subagents, not `Workflow`.** Workflows cannot be paused or
  corrected mid-flight.
- **Base every worktree on current `main` and re-verify after each merge.** All
  of round 9 was authored on a round-7-era commit and shipped two silent
  semantic conflicts that merged cleanly and broke at runtime.
- **Never blanket-kill.** An orphan is a process reparented to init; another
  author's live process still has a live parent.
- **Delete rather than fix forward.** The corridor `dirt` term went from doing
  nothing (ratio 1.00) straight past its 0.7x target to 0.40x while being fixed.
- **A green probe proves nothing by itself.** This round's end-card check passed
  for the wrong reason (matched `RANK` anywhere in the whole UI with the menu
  still mounted), then failed for the wrong reason (`RANK` + value `S` renders
  as "RANKS", so `\bRANK\b` misses a working card). Scope your assertion and
  look at what it actually matched.
- **Judge by eye, not by statistics.** Statistics are for catching regressions.

---

## 6. Honest assessment

Best frames are around 7.5/10 against the reference's 9.5-10. The gap is asset
density and surface history, which is studio-years of authoring rather than
rounds of iteration; it will not become indistinguishable from MGSV.

What changed this round is mostly that the *instruments* can now be trusted:
the establishing shot is reproducible for the first time, ablation numbers have
null controls under them, and "which system draws that" is a nine-second
question instead of a guess. Three defects that had been on the list for two
rounds turned out to be misdiagnosed, and were only caught because those tools
existed. Expect more of the remaining list to be wrong in the same way.
