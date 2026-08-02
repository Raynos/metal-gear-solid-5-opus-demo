// ROUND 8. What is the terrain actually PAINTING in the mid field?
//
// The vista frame measures 4.25 stops against MGSV's 7.31 and its mid-field
// minimum luma never goes under 76 on a 1280x720 frame. Before tuning anything,
// find out which material the mid buttes and the pan are being drawn AS: the
// hypothesis is that rockW is ~0 out there, so what looks like a mountain range
// is being shaded with the sand ramp and can never carry rock's dark end.
//
// uDbg2.w is the mask read-out hook in Terrain's fragment shader: 1 = rockW,
// 2 = screeW, 3 = region, 4 = sub, 5 = flowW. The frame becomes that mask as a
// greyscale albedo, so this is a pixel measurement, not an opinion.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, scene = engine.scene;
const gl = renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;

let terrainU = null;
scene.traverse((o) => {
  if (o.isMesh && /^terrain-L/.test(o.name || '') && o.material?.userData?.uniforms) {
    terrainU = o.material.userData.uniforms;
  }
});
if (!terrainU) {
  // Terrain shares one material; find it via the world handle instead.
  terrainU = g.world?.terrain?.uniforms ?? engine.world?.terrain?.uniforms ?? null;
}
if (!terrainU) return { error: 'no terrain uniforms', names: scene.children.map((c) => c.name) };

function grab() {
  g.settle(4);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
// Rows as fractions of frame height, so this reads the same on any resolution.
const BANDS = { far: [0.22, 0.36], mid: [0.36, 0.55], near: [0.55, 0.75] };
function bandMean(px, band) {
  let s = 0, n = 0;
  for (let y = Math.round(band[0] * H); y < Math.round(band[1] * H); y += 2) {
    const row = H - 1 - y;
    for (let x = 0; x < W; x += 2) {
      const i = (row * W + x) * 4;
      // The mask is written as albedo, so read the green channel and undo the
      // sRGB the composite applied. Lighting still multiplies it, so this is a
      // RELATIVE reading between masks in the same band, not an absolute weight.
      s += px[i + 1];
      n++;
    }
  }
  return +(s / n).toFixed(1);
}

const out = {};
for (const shot of ['vista', 'ridge']) {
  g.applyShot(shot);
  out[shot] = {};
  for (const [name, id] of [['off', 0], ['rockW', 1], ['screeW', 2], ['region', 3], ['sub', 4], ['flowW', 5]]) {
    terrainU.uDbg2.value.w = id;
    const px = grab();
    out[shot][name] = Object.fromEntries(
      Object.entries(BANDS).map(([k, b]) => [k, bandMean(px, b)]),
    );
  }
  terrainU.uDbg2.value.w = 0;
}
return out;
