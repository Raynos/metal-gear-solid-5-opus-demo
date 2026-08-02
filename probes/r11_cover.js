// Ground cover, by ID pass rather than by difference.
//
// The statistical A/B against a `--hide` ablation cannot answer this: hiding
// meshes perturbs AO and the volumetric history, and — worse for this question —
// a stone that has been brought WITHIN a stop of the sand it lies on stops
// registering as "changed" at all, so the very fix being measured reads as a
// loss of cover. Painting the meshes with a flat unlit colour and counting the
// pixels they actually own is immune to both.
//
// Reports, per shot, the percentage of the frame owned by the clast field and by
// the woody scatter, plus the same restricted to the bottom third of the frame
// (the "near band" TODO.md 1.6 quotes 0.43% for).
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
const gl = eng.renderer.getContext();
eng.pipeline.enabled.autoExposure = false;

const groups = { clast: [], woody: [] };
g.world.scene.traverse((o) => {
  if (!(o.isMesh || o.isInstancedMesh) || !o.visible) return;
  const n = o.name || '';
  if (/^clast-/.test(n)) groups.clast.push(o);
  else if (/^(bush|scrub|brush|tree)-/.test(n)) groups.woody.push(o);
});

const out = { shots: {}, counts: { clast: groups.clast.length, woody: groups.woody.length } };

// The clast bodies EXIST only inside their own vertex shader — the instanced
// geometry is a unit octahedron at the origin until CLAST_BODY places it — so
// swapping in a flat MeshBasicMaterial collapses the whole field to a point and
// measures nothing. (It reported 0.002% of frame, which is how it was caught.)
// Keep the material, and make it emit: emissive is added after the injected
// diffuse term, so an over-bright magenta survives tone mapping and grading as
// the only thing in the frame with R and B far above G.
function measure(list) {
  const prev = list.map((m) => ({
    color: m.material.color?.clone(),
    emissive: m.material.emissive?.clone(),
  }));
  list.forEach((m) => {
    m.material.color?.setRGB(0, 0, 0);
    m.material.emissive?.setRGB(6, 0, 6);
  });
  g.settle(3);
  const s = eng.renderer.getSize(new THREE.Vector2());
  const w = s.x | 0;
  const h = s.y | 0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  list.forEach((m, i) => {
    if (prev[i].color) m.material.color.copy(prev[i].color);
    if (prev[i].emissive) m.material.emissive.copy(prev[i].emissive);
  });
  let all = 0;
  let near = 0;
  // readPixels is bottom-up, so rows 0..h/3 ARE the bottom third of the image.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (px[o] > 90 && px[o + 2] > 90 && px[o + 1] < px[o] * 0.7) {
        all++;
        if (y < h / 3) near++;
      }
    }
  }
  return { all: +((100 * all) / (w * h)).toFixed(3), near: +((100 * near * 3) / (w * h)).toFixed(3) };
}

for (const shot of ['ground', 'gameplay', 'outpost', 'vista']) {
  g.applyShot(shot);
  g.settle(6);
  out.shots[shot] = { clast: measure(groups.clast), woody: measure(groups.woody) };
}
return out;
