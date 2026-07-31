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
node tools/calibrate.mjs vista    # sweep lighting params, print luminance response
```

`tools/shot.mjs` exits **non-zero** if the page threw. A shot run that reports
page errors is a failed build, not a style choice.

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

Measured by `tools/shot.mjs` at 1920×1080 on an M3 Pro (reported per shot):

- **< 8 ms** CPU frame time per shot.
- **< 600** draw calls.
- **< 4 M** triangles.

Use `InstancedMesh` for anything appearing more than ~20 times. Merge static
geometry. Budget overruns are regressions — the harness prints these every run.

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
