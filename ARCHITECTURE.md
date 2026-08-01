# Architecture & working agreement

A Three.js action-stealth game targeting the visual bar of *Metal Gear Solid V:
The Phantom Pain* (Fox Engine, Afghanistan). Everything is procedural — no
binary art assets, no network fetches. Geometry, textures and animation are all
generated in code.

## Run it

```bash
npm run dev                       # http://127.0.0.1:5173 — WASD + drag to look
node tools/shot.mjs               # all canonical shots -> shots/
node tools/shot.mjs vista ground --out shots/mine
node tools/shot.mjs eval probe.js # run a probe inside the live page
node tools/shot.mjs pix stats shots/mine/*.png
node tools/shot.mjs status | stop # inspect / shut down the render daemon
```

`tools/shot.mjs` exits **non-zero** if the page threw. A shot run that reports
page errors is a failed build, not a style choice.

### The tooling changed — read this if you have older commands in your head

The shared render **daemon is gone**. `node tools/shot.mjs ...` works exactly as
before; what is behind it changed.

The daemon existed to keep worlds warm, because generating one cost 17 s. Both
halves of that premise failed:

  1. The expensive part — an 11.6 s terrain erosion sim — is now baked through
     GenCache, so a cold world is ~4.5 s.
  2. Agents edit source constantly, so the warm world was invalidated anyway.
     Measured hit rate: 40% of requests paid a full rebuild.

What the shared daemon did deliver, measured with seven agents against it:
queue depth 20, **p50 wait 302 s**, p50 total 360 s, and **29 errors against 9
completions**. A private, short-lived chromium per invocation instead:

| | daemon | private browser |
| --- | --- | --- |
| 7 trees x 3 shots (21 screenshots) | did not complete | **21.4 s** |
| errors | 29 / 9 completions | **0** |
| leftover processes | 19 vite, 15 headless | **0** |
| one shot, warm cache | 0.76 s | 6.9 s |
| one shot, cold | 53 s | 13.5 s |

A resident world is still faster for a single author taking repeated shots, and
that is the one thing given up. It is not close to worth the rest.

**Batch your shots.** Each invocation pays ~4.5 s for the world, then ~0.6-1 s
per screenshot, so ask for every shot you want in ONE command.

```bash
node tools/shot.mjs                       # every canonical shot
node tools/shot.mjs vista ground --out shots/mine
node tools/shot.mjs eval probe.js         # run a probe in the live page
node tools/shot.mjs pix stats 'shots/*.png'
node tools/bench.mjs --quick              # benchmark the whole inner loop
```

`tools/bench.mjs` measures cold/warm/resident build, single and batched photo
cost, N-tree parallel drain, and leftover processes, appending each run to
`bench-history.jsonl`. Run it before and after anything that touches the loop.

### Worktrees share node_modules — two traps

Agent worktrees symlink one `node_modules`, so anything vite keeps in there is
shared. Both of these produced silent, confusing failures:

- **Vite's cache.** Seven concurrent builds writing `node_modules/.vite`
  corrupted each other and produced pages that loaded but never became ready.
  `cacheDir` is now `.vite-cache`, inside each tree.
- **The generation cache** is shared, which is desirable — but its key must
  include a hash of the generator. `vite.config.js` injects `__TERRAIN_HASH__`
  from the contents of `Terrain.js`, so editing terrain invalidates the bake
  instead of silently loading a sibling tree's landscape. Entries expire after
  24 h and the directory is capped at 4 GB, LRU.

## File ownership — DO NOT CROSS THESE LINES

Multiple authors work in parallel. Editing a file you do not own causes lost
work. Each area owns its directory and nothing else:

| Area          | Owns                                                     |
| ------------- | -------------------------------------------------------- |
| engine core   | `src/core/`, `src/main.js`, `tools/`                     |
| render/post   | `src/render/RenderPipeline.js`, `src/render/Sky.js`, `src/render/Lighting.js` |
| volumetrics   | `src/render/volumetrics/`                                |
| terrain       | `src/world/Terrain.js`                                   |
| rocks         | `src/world/rocks/`                                       |
| vegetation    | `src/world/vegetation/`                                  |
| outpost       | `src/world/outpost/`                                     |
| characters    | `src/characters/`                                        |
| gameplay + AI | `src/gameplay/`, `src/ai/`                               |
| UI/HUD        | `src/ui/`                                                |
| audio         | `src/audio/`                                             |

`src/config/ArtDirection.js` and `src/debug/Shots.js` are **shared read-mostly**.
Read them freely. Do not restructure them. If you must add a constant, append it;
never reformat or reorder what is there.

## Module contract

Every feature directory has an `index.js` exporting:

```js
export async function install(world) { /* ... */ }
```

Called once at boot from `src/main.js`, in a fixed order, after
terrain/sky/lighting exist. `world` is:

```js
{ engine, scene, sky, lighting, terrain, registry }
```

- `terrain.heightAt(x, z)` / `terrain.normalAt(x, z)` — ground placement.
- `registry` — modules installed earlier publish handles here (e.g.
  `registry.outpost`, `registry.characters`). Read defensively; a module may
  have failed to install.
- Per-frame work: `world.engine.addSystem({ order, update(dt, engine) {} })`.
  Lower `order` runs first. Lighting is `-50`, terrain `10`, free-fly camera `1000`.

A module that throws is caught and logged; the rest of the game still boots.

## Rendering contract

- The renderer writes **linear HDR** into a half-float buffer. `toneMapping` on
  the WebGLRenderer is `NoToneMapping` — ACES + grade happen in
  `RenderPipeline`'s composite pass. Never set `renderer.toneMapping`.
- Lights are in three.js physical units. Calibrated so a sunlit sand surface
  lands near 0.5 mean display luminance. If you add lights, check with
  `window.__GAME.probeLuminance()` — target mean **0.42–0.55**, clipped **< 0.6%**
  for daylight shots.
- Ambient comes from a PMREM env map generated from the Sky dome
  (`scene.environmentIntensity`). `HemisphereLight` is deliberately at 0 —
  turning it up double-counts sky light and washes the image out.
- New materials: `MeshStandardMaterial` (or `MeshPhysicalMaterial`) with
  `onBeforeCompile` injection is the house pattern — it inherits shadows, IBL
  and fog for free. Raw `ShaderMaterial` for world geometry loses all of that.
- Everything that should occlude must set `castShadow`/`receiveShadow`.

## Performance budget

Measured by `node tools/shot.mjs eval tools/probes/perf.js` — **not** by the
per-shot number alone. Targets at 1920x1080 on an M3 Pro:

- **< 16.7 ms** frame time (60 FPS) with the camera MOVING, not static.
- **< 350** draw calls.
- **< 2.5 M** triangles.

Read the header of `tools/probes/perf.js` before making any frame-time claim.
The short version: for six rounds the budget read "2.7 ms, within budget" while
the game ran at 14-24 FPS, because the old measurement timed five frames
immediately after a settle. Those frames are only *enqueued* — the GPU queue is
empty, so submission returns at command-buffer write speed. The cost ramp over
consecutive 20-frame blocks is [2.8, 47.4, 40.7, 40.8, 40.4, 41.5]: only the
first block is cheap, and that was exactly the window being sampled.

The same mistake understated geometry, because six frames is not long enough for
the LOD rings to finish populating — the same shot reports 380 draws / 3.4 M
triangles at six frames and 543 / 4.7 M once warm.

Three rules for any frame-time claim:
1. Warm until the GPU queue is saturated; discard the first block.
2. Measure throughput over many frames, not the latency of a few.
3. **Move the camera.** A static pose skips clipmap updates, shadow-cascade
   refits, TAA history invalidation and LOD churn — all of which a player pays
   for every single frame. Panning currently costs 3x a static pose.

Use `InstancedMesh` for anything appearing more than ~20 times. Merge static
geometry. Cull per shadow cascade, not just against the main frustum.

## Visual target (the bar every change is judged against)

Afghanistan, *The Phantom Pain*. High-key, low-saturation desert. Sun is brutal
and near-white; shadows are lifted, cool, and full of bounced sky light — never
crushed to black. Aerial perspective is very strong: distant ridges wash to pale
dusty blue-grey within ~2 km. The grade is a restrained split-tone — cool
cyan-grey shadows, warm khaki midtones — *not* orange-and-teal. Permanent fine
film grain, mild bloom, and a sharp, contrasty final image.

Read `src/config/ArtDirection.js`; it encodes all of this as data.

## Non-negotiables

1. **Never break the build.** Run `node tools/shot.mjs <a shot>` before you
   finish. Zero page errors.
2. **No external assets or network calls at runtime.** Procedural only.
3. **Never leave placeholder geometry visible.** A grey box is worse than nothing.
4. Comment *why*, not *what*. Match the density of the surrounding code.
