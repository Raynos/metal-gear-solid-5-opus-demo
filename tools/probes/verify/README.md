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
