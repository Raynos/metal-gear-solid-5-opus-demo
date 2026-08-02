# TODO

State as of the end of the round-9 session. Everything here is either measured or
was reported by a human playing the build — nothing is speculative.

Read `CLAUDE.md` first (rules), then `ARCHITECTURE.md` (ownership, tooling).

---

## 0. The one change that stops the machine melting

**Route `tools/shot.mjs` through the daemon instead of `render.mjs`.**

The daemon works. It is pinned to main, publishes its own source hash, refuses
stale clients, evicts on measured memory, exits after 10 min idle. `tools/shotd-client.mjs`
connects to it. **Nothing points at it.** `shot.mjs` is still a shim over
`render.mjs`, which spawns a private browser per invocation — so seven parallel
agents produced **27 chromium processes and 6.8 GB**.

- `shot.mjs` should `connect()` via `shotd-client`, and fall back to a private
  browser only when no daemon is running.
- Start the daemon in its own herdr pane, from main: `node tools/shotd.mjs --idle 600`
- Move that pane: `herdr pane move <id> --new-tab --workspace w5` (bare
  `--workspace` is not valid syntax — that is why the earlier move failed).
- Add a **heartbeat line** to the daemon: queue depth, resident worlds, memory,
  every ~15 s. The pane currently sits blank until something breaks, which is
  why "which pane is it in" and "how many chromiums" were unanswerable.

---

## 1. Graphics — what a human saw while playing

Ranked by how loudly it reads. All four were invisible in the seven static
screenshots this project spent nine rounds optimising against.

### 1.1 The world is brown
Not the grade — that is fixed and neutral now. The *world* is one material family.

- Mountains are the same colour as the sand they rise out of.
- **Bug**: `uRockLight` is `0.198` in `Terrain.js` and `0.534` in
  `RockMaterial.js`, so boulders render 5.6x brighter than the cliffs they fell off.
- Measured: 93% of the frame's chromatic mass sits in ONE hue octant; the nine
  reference frames average 54%. Ground band has **zero** pixels above L\* 85;
  the references average 2.8%.
- Wanted, in the user's words: "reds, greens, sands, browns, greys, blacks — just
  use all kinds of colours that fit in the scene". Low saturation, many hues —
  variety, not intensity.
- Add distinct classes selected by ONE low-frequency field: pale near-white
  crust, red-brown iron soil, near-black basalt, warm sand as one member of a set.

### 1.2 Swirling paisley moiré on the ground
Concentric wood-grain swirls across the valley floor, strongest at grazing
angles, moving with the camera. **This is the "distorted" complaint.**

Not texture filtering — detail textures already have mipmaps and anisotropy 16.
It is **procedural noise evaluated per-pixel in the fragment shader**, which
cannot be mip-filtered and aliases exactly like this. Domain-warped fbm produces
that signature.

Fix by DELETING: fade the noise octaves out with distance before they alias
(`fwidth()` against the noise period is the honest cutoff), or bake them into a
texture that can be filtered. Do not add a de-noising pass — more machinery on a
problem caused by too much machinery.

### 1.3 Hard-edged black shadow blobs
Irregular dark patches with stepped edges on ground and mountain flanks. Shadow
acne or a cascade-boundary artefact. Check whether terrain normals disagreeing
with the geometry are the cause.

### 1.4 Pale angular shards on the mountains
Small bright wedges that look like broken LOD or z-fighting slivers. Terrain
clipmap seams or the rocks module — diagnose which.

### 1.5 Everything is detailed at exactly one scale
From a blind comparison against the real game:

> "Objects have a silhouette and one broad soft gradient, and below that nothing:
> no 10 cm structure, no 1 cm structure, no grain. Nothing has weight and nothing
> is seated. It is a beautifully lit blockout."

The precise tell: in the real frames every pebble is a lit face plus a dark face
plus a contact shadow. In ours they are albedo marks painted on a flat plane —
they look identical no matter where the sun moves.

- Detail normal at ~0.5 m, strongest 0-15 m, faded before it aliases (see 1.2).
- Instanced pebble/rubble geometry in the near band that actually casts.
- **Contact-scale AO**: this is NOT "add AO" — ablation confirms SSAO is present
  and strong (mean ratio 0.77-0.88). It occludes at a LARGE radius. A second
  5-20 cm term is needed for sandbag seams, wall/pilaster corners, barrel bases.
- Screen-space contact shadows.

### 1.6 Ground cover
0.43% of the near band against the reference's 40-50%. Vegetation is 0.38-2.24%
of any frame; loose stone is 0.00%.

### 1.7 Palette bugs found by measurement, all cheap
- `src/world/outpost/geo.js:13` — `KEEP` drops `aVar` before merging, so `vOPV`
  is `(0,0,0)` on every merged mesh. That silently disables the 3-tone palette
  selector, per-object value jitter and per-instance wear on the four biggest
  man-made surfaces. **Every sandbag in the frame is the same colour by accident.**
  One line.
- `mat.js:361` and `mat.js:401` — the rust smoothstep fires on 43-50% of every
  metal sheet; should be 15-20%. `op-corr` is authored as pale blue-grey primer
  (B/R 1.13) and renders warm (B/R 0.75) because half of it is rust.
- Terrain macro tone is ±8% RMS against a source comment claiming 1.46 stops.
- Spectrum hole at 60-250 m: `region`/`sub` are documented as 240 m / 82 m but
  deliver 30 m and 10 m, so adjacent hillsides 200 m apart look identical.

**Do NOT chase**: "the specular is broken" is FALSE. Those shaders overwrite
`roughnessFactor` unconditionally, so setting `material.roughness` from a probe
ablates nothing — the old test measured itself. Ablated properly through the
materials' own `uAbl` uniforms, `op-steel` reads 16.7/255 against a 5.0 noise
floor. Authored metal works.

---

## 2. Performance

**16-29 FPS in play** at 1920x1080 with the camera moving. Target 16.7 ms; best
case is 2.0x over, typical 3.3x.

| | ms | share |
| --- | --- | --- |
| scene rasterisation, main camera | 22.0 / 30.3 | **58-70%** |
| post chain, all of it | 13.4 / 15.6 | 30-40% |
| shadow maps (229 draws, 1.70 M tris) | 0.88 | below noise |
| all CPU systems | 0.25 | below noise |

- **The optimisation target is the main pass's per-pixel cost.** Not draw calls
  (the entire CPU side is 0.25 ms; the real Fox Engine spends 2331 draws a frame),
  not shadows (1.7 M triangles rasterise in 0.9 ms), not the CPU.
- Overdraw is the obvious unmeasured suspect — alpha-tested vegetation especially.
- Geometry: 447-524 draws, 3.8-4.4 M triangles. Budgets of <350 / <2.5 M both
  fail, but **budget frame time, not draw count**.
- `pipeline.setRenderScale()` exists and is deliberately unused. Do not reach a
  frame-rate target by shipping a smaller buffer.

### Measurement rules — the instruments have been wrong five times
1. A budget that timed five ENQUEUED frames: reported 2.7 ms for a 40 ms frame.
2. A screenshot path rendering 54 frames per photo.
3. Ablation flags that gated nothing (`dof`/`motionBlur` share a pass;
   `autoExposure`/`aerial` only flip a uniform; `fxaa` is dead when TAA is on).
4. A GPU timer query reading 6x wall clock.
5. `gl.finish()` after work that is never PRESENTED returns at submission speed —
   scene-into-HDR, a strict subset, measured 32.76 ms in the same round the whole
   frame measured 5.08 ms.

Use the browser's own rAF loop with exactly one present per tick, interleave
workloads round-robin, take costs as increments between neighbours, and print
"below noise" rather than a number the instrument cannot resolve. A control that
should read zero (e.g. `fxaa` with TAA on) read **6.3 ms** — nothing below ~6 ms
is claimable.

---

## 3. Gameplay

Verified working end to end (24 assertions): spawn stays CALM for 30 s, approach,
CAUTION → ALERT → EVASION and the garrison giving up, take fire, die → MISSION
FAILED, shoot the commander → MISSION ACCOMPLISHED, fire, reload, wall-slide,
camera stays out of geometry.

Still missing or wrong:

- **No takedown animation** (CQC is `F`).
- **No firing feedback** — no muzzle flash, no impact, no shell, and audio is
  installed (2956 lines, in `MODULES`) but apparently silent in play. Find out
  whether the AudioContext never resumes, or gameplay never calls it.
- **No reload animation** — the magazine refills on a timer and the character
  does nothing.
- **Gun model is poor.**
- **The mission has no shape.** "Mission accomplished is so lacklustre, I random
  shoot a guard and I'm done." The commander needs to be somewhere that requires
  infiltrating, with consequences for being seen and an exfil. This is the
  sharpest gameplay note in the session and it is a design problem, not polish.

---

## 4. Characters

Model 4.5/10, animation 7/10. **The animation foundation is verified good** —
a foot held its world position identically to four decimal places for seven
consecutive frames while the body travelled 0.31 m (zero slide), terrain
conforming works, the weapon never leaves the hands. Do not rebuild it.

- **The neck is the worst single element**: a bare skin-coloured cylinder of
  near-constant diameter, too long, no trapezius or clavicle transition. Being
  bare skin against olive cloth it is the highest-contrast thing on the body.
  Rebuild the junction and occlude it with a collar.
- **The upper body is a rigid passenger.** Hands travel 8 cm where a run needs
  30-50, and `handR` vertical tracks `head` vertical — they are riding the torso,
  not swinging. **The gait axis already exists; nothing consumes it.**
- **Guards do not patrol.** All 12 sit in state `post`; 5 moved 0.00 m in 20 s;
  none change stance. The locomotion system that makes the player look good is idle.
- 13 characters share ONE palette, so all shape variation dies past 15 m.
- The commander is distinguished only by an ABSENT helmet and vest — no positive
  rank marking, so you cannot pick him out in a moving frame.
- Camouflage: fatigues are one flat olive-grey. Every soldier in the reference
  wears a two- or three-tone pattern at ~15 cm; a measuring reviewer called it
  "the single most legible 'this is a real game asset' cue in those frames".
- No ears; no separated fingers at the grip.
- Head proportion is **fixed** (0.388 against a 0.37-0.40 norm). Stop citing 0.52.

---

## 5. Process

- **Use steerable subagents, not `Workflow`.** Workflows cannot be paused,
  steered or resumed; a mid-flight correction means killing work. This cost real
  time this session.
- **Check the base commit** when spawning parallel work. Round 9 was launched
  from a commit **54 behind main**, missing an entire round's merge, with
  `RenderPipeline.js` differing by 533 lines. Caught before any work was lost,
  but only by looking.
- **Never blanket-kill.** `pkill -f chrome-headless-shell` kills other authors'
  in-flight runs. An orphan is a process **reparented to init** — another
  author's live process still has a live parent.
- **Delete rather than fix forward.** The sepia grade was nine rounds of warm
  nudges, each justified by a measurement, that multiplied to a 1.19 cast. Every
  step was locally correct and the chain was worse than the start.
- **Judge by eye, not by statistics.** Matching a histogram optimises the wrong
  thing. Statistics are for catching regressions, not for setting direction.
- **Verify in motion.** Every problem a human found — smearing, tearing, the
  cloud loop, the moiré — was invisible in the seven static camera poses this
  project was optimised against for nine rounds.

---

## 6. Honest assessment

Best frames score 7/10 against the reference's 9.5-10. The gap is asset density
and surface history, which is studio-years of authoring, not rounds of iteration.
It will not become indistinguishable from MGSV.

Genuinely finished, verified by ablation, and better left alone:
the tone curve; night lighting ("the one frame I'd put in a trailer"); **sky and
clouds, which beat the real game** (MGSV's are flat blown-out white cards);
aerial perspective across kilometres; shadow penumbra growth with occluder
distance; the HUD; and the locomotion foundation.
