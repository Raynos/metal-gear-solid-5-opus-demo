/**
 * r11_shards.js — which system draws the pale angular plates on the ground?
 *
 * The near and mid ground of shots/r11-chars/gameplay.png and shots/r11-film-
 * ground/* is littered with pale, flat, angular shapes that read as paper
 * cut-outs rather than stones. It is the loudest visual defect in the current
 * build and it is NEW -- round 9/10 work, not something nine rounds looked at.
 *
 * There are three candidates and they belong to two different owners, so
 * guessing wrong wastes somebody's round:
 *
 *   world/vegetation/Clast.js   camera-relative loose stone, 5 rings, 22.9k
 *                               instances, a `flake` fraction of 0.26-0.34 and
 *                               ring D/E sizeMax of 0.42/0.62 m
 *   world/rocks/Scatter.js      map-wide stone, seated at seat - height*bury,
 *                               where Terrain.seatHeightAt() takes a min over
 *                               the lattice and can sink a body ~6.8 m below
 *                               the drawn surface at 500 m -- leaving one facet
 *   world/vegetation/Scrub.js   alpha-tested plant cards seen edge-on
 *
 * So: hide each group in turn, count how much of the ground band changes, and
 * let the pixels name the owner. Reads the presented frame rather than a render
 * target, because the defect is defined by how it LOOKS after the grade.
 */
const g = window.__GAME;
const eng = g.engine;
const THREE = g.THREE;
const renderer = eng.renderer;
const gl = renderer.getContext();

g.applyShot('ground');
eng.deterministic = true;
eng.stop();

const W = 480, H = 270;                   // read a downsample; we want areas, not detail
function capture() {
  // Pin BEFORE every capture, not once at the start.
  //
  // The first version of this probe stepped 12 frames per capture and its own
  // restore check -- baseline against baseline, nothing hidden -- came back at
  // 13.02% of the band changed. That is larger than most of the groups being
  // measured, so every number it produced was noise. TAA history, the AO's
  // temporal rotation, the grain seed, the shadow cascade refresh phase and the
  // volumetric haze history all integrate across captures, so capture N and
  // capture N+1 are different frames of the same scene.
  //
  // __pinDeterminism is installed by tools/render.mjs and resets all of them.
  // ...and converge through settle(), not a hand-rolled step loop. settle() is
  // the thing that rewinds the pipeline's free-running frame counter, which
  // drives the TAA jitter phase (JITTER[frame % 16]), the AO's temporal
  // rotation (frame % 64) and the grain's time seed. Stepping by hand leaves
  // that counter running, so consecutive captures land on different jitter and
  // grain phases -- which took the restore check from 13.02% to 8.54% when the
  // pin was added and no further, because the pin does not touch the counter.
  if (window.__pinDeterminism) window.__pinDeterminism();
  g.settle(24);
  const fw = renderer.domElement.width;
  const fh = renderer.domElement.height;
  const px = new Uint8Array(fw * fh * 4);
  gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // Bottom 45% of the frame is the ground band. readPixels is bottom-up, so
  // that is the FIRST 45% of the rows.
  const rows = Math.floor(fh * 0.45);
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor((y / H) * rows);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor((x / W) * fw);
      const s = (sy * fw + sx) * 4;
      const d = (y * W + x) * 3;
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2];
    }
  }
  return out;
}

/** Fraction of the band that differs by more than 6 codes, and its mean shift. */
function diff(a, b) {
  let n = 0, sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 18) n++;
    sum += (a[i] - b[i] + a[i + 1] - b[i + 1] + a[i + 2] - b[i + 2]) / 3;
  }
  const px = a.length / 3;
  return { changedPct: +((n / px) * 100).toFixed(2), meanShift: +(sum / px).toFixed(2) };
}

/**
 * Collect the candidate groups by walking the scene once. Matched on the
 * material/geometry the modules actually create rather than on object names,
 * which no module guarantees.
 */
const groups = { clast: [], rocks: [], scrub: [], grass: [] };
g.world.scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh || o.isPoints)) return;
  const n = (o.name || '').toLowerCase();
  const mn = (o.material && o.material.name || '').toLowerCase();
  const tag = n + ' ' + mn;
  if (tag.includes('clast')) groups.clast.push(o);
  else if (tag.includes('scrub')) groups.scrub.push(o);
  else if (tag.includes('grass')) groups.grass.push(o);
  else if (tag.includes('rock') || tag.includes('talus') || tag.includes('scatter') || tag.includes('boulder')) groups.rocks.push(o);
});

const baseline = capture();
const result = {};
for (const [name, list] of Object.entries(groups)) {
  if (!list.length) { result[name] = { meshes: 0, note: 'no meshes matched by name' }; continue; }
  const was = list.map((m) => m.visible);
  list.forEach((m) => (m.visible = false));
  const off = capture();
  list.forEach((m, i) => (m.visible = was[i]));
  result[name] = { meshes: list.length, ...diff(baseline, off) };
}

// Restore and prove the restore worked: if this is not ~0 the numbers above are
// measured against a scene that never came back.
const after = capture();

return {
  shot: 'ground',
  band: 'bottom 45% of frame, 480x270 downsample',
  note: 'changedPct = share of the ground band this group draws. meanShift > 0 means the group is BRIGHTER than what is behind it.',
  groups: result,
  restoreCheck: diff(baseline, after),
  meshNames: Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, v.slice(0, 6).map((m) => m.name || '(unnamed)')]),
  ),
};
