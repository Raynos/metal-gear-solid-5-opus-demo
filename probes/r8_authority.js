// ROUND 8. How much AUTHORITY do the terrain's tonal fields and the vegetation
// cover layer actually have over the pixels of a wide shot?
//
// The round-8 palette widened the terrain's albedo swing from 0.82 stops to 1.38
// and the vista's mid-pan spatial sd did not move (12.4% -> 12.1%). Either the
// modulation is not reaching the frame, or something downstream — aerial
// perspective — is diluting it. Ablating the modulation entirely (uDbg2.y = 0
// replaces it with the constant 1.04) answers that in one render: if sd barely
// changes with the whole layer OFF, the layer is not what is limiting the frame.
//
// The same run sweeps COVER.gain, which is the only knob this module has that
// costs no triangles: it decides how much of the pan the tonal vegetation layer
// is allowed to cover.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, scene = engine.scene;
const gl = renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;

// Terrain keeps its uniforms on the Terrain instance, not on material.userData.
let terrainU = g.world?.terrain?.uniforms ?? engine.world?.terrain?.uniforms ?? null;
let coverLocal = null;
scene.traverse((o) => {
  if (o.isMesh && o.name === 'grass-cover') coverLocal = o.userData.local;
});
if (!terrainU || !coverLocal) return { error: 'handles missing', terrainU: !!terrainU, coverLocal: !!coverLocal };

function grab() {
  g.settle(4);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
// Fractions of frame height so this reads the same at any resolution.
function stat(px, y0f, y1f) {
  const vs = [];
  for (let y = Math.round(y0f * H); y < Math.round(y1f * H); y += 2) {
    const row = H - 1 - y;
    for (let x = 0; x < W; x += 3) {
      const i = (row * W + x) * 4;
      vs.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    }
  }
  const m = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - m) * (b - m), 0) / vs.length);
  vs.sort((a, b) => a - b);
  return { mean: +m.toFixed(1), sd: +sd.toFixed(2), rel: +(100 * sd / m).toFixed(1), p1: +vs[(vs.length * 0.01) | 0].toFixed(1) };
}
const BANDS = { massif: [0.28, 0.46], midpan: [0.53, 0.67] };
function read() {
  const px = grab();
  return Object.fromEntries(Object.entries(BANDS).map(([k, b]) => [k, stat(px, b[0], b[1])]));
}

g.applyShot('vista');
const out = {};
const gain0 = coverLocal.uPatch.value.z;

out.shipped = read();
terrainU.uDbg2.value.y = 0;             // tonal modulation -> flat 1.04
out.tonalOff = read();
terrainU.uDbg2.value.y = 1;

for (const gn of [0.0, 4.2, 7.0, 11.0]) {
  coverLocal.uPatch.value.z = gn;
  out['coverGain_' + gn] = read();
}
coverLocal.uPatch.value.z = gain0;
return out;
