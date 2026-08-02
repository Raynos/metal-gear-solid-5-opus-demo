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

**The frame is `7.8 ms fixed + 18.7 ms per-pixel` at native 1920x1080.** A
two-point fit over render scale predicts both middle scales to within 0.2 ms:

| scale | pixels | measured | model |
| --- | --- | --- | --- |
| 1.00 | 1.000 | 26.44 | — |
| 0.85 | 0.722 | 21.05 | 21.25 |
| 0.70 | 0.490 | 16.94 | 16.92 |
| 0.55 | 0.303 | 13.43 | — |

**Round 9's TODO said the target was "the main pass's per-pixel cost" at 58-70%
of the frame. That is wrong.** The whole scene into the HDR target is 6.8-8.8 ms
— roughly a quarter — and 548 draws and 5.5 M triangles rasterise inside it.
Draw count and triangle count are both well over their stated budgets and
cutting them would buy nothing.

What is priced, with null controls:

| | cost |
| --- | --- |
| occlusion pass (SSAO + micro + contact) | 2.46 ms |
| volumetrics, whole module | 2.5 ms (cumulus march 1.68, its light march 0.89) |
| DOF + motion blur pass | 0.89 ms, at the block spread |
| bloom, all of it | below noise |
| composite CA / LUT / grain | each below a 0.57 ms floor |

**~12 ms of the per-pixel half is still unattributed.** It is not bloom, not the
composite's features, not volumetrics. It is in the passes with no `enabled[]`
flag — prep, the 6-level luminance chain, adaptation, composite, present/FXAA —
and nobody has built a switch for them. That is the next person's first job.

**60 FPS at native needs per-pixel cut from 18.7 ms to 8.9 ms.** Better than
half, in a chain whose expensive members have no switches. That is pass fusion
and full-resolution work removal, not tuning.

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
argument is worthless: the vegetation author independently found that **clast
does not receive the cascaded shadow at all** — `csmSunVis` returns 1.0 over
every clast fragment, and an unbiased cascade-0 depth compare also returns
"lit". Chips that cannot receive a shadow tell you nothing about whether one is
there. Cropped close (`shots/crop-road.png`) the band has hard straight edges,
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
