# Integration acceptance probes — round 6

Run against the live page with `node tools/shot.mjs eval tools/probes/verify/<x>.js`.
Every one of these ABLATES the thing it measures rather than scanning pixels
across an unknown surface, because round 5 produced three mutually contradictory
"measurements" of the same two features and all of them were wrong.

| probe | question |
| --- | --- |
| `a3-character.js` | Is the weapon connected to the body, and is it *held* or resting on the chest? Isolates parts by swapping the index buffer — the rifle is welded into the skinned mesh, so there is no Object3D to hide. |
| `a4-proportions.js` | Head width / height / shoulder span off the bind-pose mesh. |
| `b-ambient.js` | Directional ambient, 0.5-grey matte sphere in full cast shadow, binned by normal Y. Reports display AND linear, plus a per-bin sun-leak check that proves the probe really is in shadow. |
| `c-specular.js` | Does the specular lobe contribute anything? Forces every material to roughness 1 and then 0.2 and re-runs the local-maxima detector. |
| `d-horizon.js` | Ridge vs the sky above it, and fog opacity at a measured distance, in linear radiance out of `pipeline.hdr`. |
| `d2-fogsweep.js` | The same, swept over haze density. |
| `d4-fogaccept.js` | What raising the haze does to the criteria it can *break* (highlight range, dusk cool). |
| `f-wear.js` | Ground wear, via the outpost's own `uWearCtl` kill switch. |
| `horizon-rows.js` | True horizon row per shot, from the camera matrices. |
| `j-guards.js` | AO ablation and the exposure spread across the afternoon shots. |
| `i1-ambient-codes.js` | Round 7. The shadowed sphere in DISPLAY CODES, ablated against the raw ACES toe — stops of linear light stopped being the acceptance number the moment the finding was that the print, not the transport, was wrong. Also reports what scene-linear radiance each shipped frame actually contains, which is what says whether the black-point guard is measuring the curve or measuring a frame with nothing dark in it. |
| `i2-specular.js` | Round 7. The specular ablation that reaches the surfaces. `c-specular.js` writes `material.roughness`, which is dead code on Terrain, rocks, outpost and characters alike — all four replace `<roughnessmap_fragment>`. This drives the modules' own uniforms instead. |
| `i3-fog.js` | Round 7. `d5-haze.js` reads a `SHOT_NAME` global the eval harness does not inject, so it always measured the vista — which contains no geometry past 2.7 km, which is why the 3-5 km acceptance band came back empty. Same ablation, every framing, binned by range. |
| `i4-gradesweep.js` | Round 7. The two grade levers the toe rebuild moved (`splitShadowEdge`, mid-band warmth) swept against dusk cool AND daylight R-B together, because they trade against each other and sweeping either alone picks a winner by breaking the other. |

Three traps that cost me measurements, so they do not cost you any:

1. **The free-fly camera is armed** (system order 1000) on a page where no shot
   has been applied, and it silently re-aims any camera a probe installs. Call
   `g.setFreeFly(false)` first.
2. **`VolumetricPass.syncTimeOfDay()` pushes `pass.params` into the uniforms
   every frame.** Setting `volMat.uniforms.uApGain.value` directly is reverted
   before the next render and the ablation silently does nothing. Ablate
   `pass.params`.
3. **Displacing vertices to "delete" a body part stretches every triangle that
   straddles the selection boundary across the whole frame.** My first
   arms-deleted mask came back *larger* than the whole character. Select
   triangles instead.
