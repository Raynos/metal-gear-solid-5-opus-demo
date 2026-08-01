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

`tools/calibrate.mjs`, `tools/eval.mjs`, `tools/pix.mjs` and `tools/probe-sky.mjs`
are **gone**, and so is `npm run shot`. Every one of them booted its own vite
server and its own chromium, which is the exact cost this change exists to
delete. Their capabilities are folded into `tools/shot.mjs`:

| Old command                              | New command                                  |
| ---------------------------------------- | -------------------------------------------- |
| `npm run shot`                           | `node tools/shot.mjs`                         |
| `node tools/eval.mjs probe.js`           | `node tools/shot.mjs eval probe.js`           |
| `node tools/pix.mjs stats a.png`         | `node tools/shot.mjs pix stats a.png`         |
| `node tools/pix.mjs probe a.png 10,20`   | `node tools/shot.mjs pix probe a.png 10,20`   |
| `node tools/pix.mjs crop …`              | `node tools/shot.mjs pix crop …`              |
| `node tools/pix.mjs column …`            | `node tools/shot.mjs pix column …`            |
| `node tools/calibrate.mjs`               | an `eval` probe that sweeps and calls `g.probeLuminance()` |
| `node tools/probe-sky.mjs`               | an `eval` probe that toggles layers and samples |

`node tools/shot.mjs <shots>` is unchanged, including its flags and its
non-zero-on-page-error contract. If a command you remember is missing, it is in
the table above — do not re-create the deleted file.

### How the harness works

`tools/shot.mjs` renders nothing itself. It talks to **one** render daemon
(`tools/shotd.mjs`) shared by every author on the machine: one vite server, one
chromium, a small pool of pages each holding a fully generated world. The daemon
starts on demand and shuts down when idle; nothing needs starting by hand.

This matters because generating the world costs ~17 s, of which ~12 s is the
`Terrain.js` erosion simulation. The old harness paid that on **every**
screenshot, and eight authors doing it at once turned an 18 s run into 55 s of
pure contention. Against the warm daemon a repeat shot is well under a second,
and the world is rebuilt only when a source file actually changes — once for the
whole machine, not once per author.

Measured on an M3 Pro, 1280×720:

| | old harness | daemon |
| --- | --- | --- |
| 4 shots, alone | 18.3 s | 25 s cold **/ 2.5 s warm** |
| 4 shots, 8 authors at once | 39.9–67.5 s (avg 54.6) | **4.5–11.5 s** |
| `eval` probe | ~25 s | **0.4 s** |
| shot after an edit | 18.3 s | ~16 s (one rebuild, then warm) |

Consequences worth knowing:

- **Any** edit under `src/` invalidates the warm world, so the first shot after
  an edit pays one rebuild. Batch your edits, then screenshot.
- Ask for every shot you want in one command. Extra shots cost ~0.6 s; a second
  invocation may cost a rebuild.
- `eval` and `pix` run against the same warm daemon, so probing the live page or
  measuring a PNG is effectively free. Use them freely.
- **Do not write `sleep`/retry loops around the harness.** The old harness had a
  latent bug where its readiness wait used Playwright's 30 s default instead of
  the intended 90 s, so it spuriously failed under load and everyone wrapped it
  in `for i in $(seq 1 40); … sleep 15`. That is fixed. A broken build now fails
  in ~2 s with the offending file and line, rather than hanging.

Daemon control: `node tools/shot.mjs status` / `stop`. Its state lives in
`.shotd/` (gitignored) and its log is `.shotd/log`. One daemon per working tree,
enforced by an `O_EXCL` lock: if nine authors run the client at the same instant,
nine daemons start, one wins the lock and the other eight exit before opening a
vite server. Each daemon runs **exactly one chromium** with **one warm page** by default,
because every working tree gets its own daemon and a page holds a whole
generated world (~160 MB plus GPU). Raise `SHOTD_PAGES` (max 4) only if you are
on a single tree and want the concurrency; `SHOTD_IDLE` is seconds, default 600.

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
