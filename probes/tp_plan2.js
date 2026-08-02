// Plan view of the PAN only, centred where the swirls are, at high gain.
const g = window.__GAME;
const t = g.world.terrain;
const grid = t.near;
const n = grid.n, h = grid.h, cell = grid.cell, org = grid.origin;
const cx = -160, cz = 240;                 // world metres, inside the swirl field
const S = 512;
const i0 = Math.round((cx - org) / cell) - S / 2;
const j0 = Math.round((cz - org) / cell) - S / 2;
const c = document.createElement('canvas');
c.width = S; c.height = S;
const ctx = c.getContext('2d'), im = ctx.createImageData(S, S);
let mn = 1e9, mx = -1e9;
const gain = +((ARGS || [])[0] || 3000);
for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
  const a = (j0 + j) * n + (i0 + i);
  const gx = (h[a + 1] - h[a - 1]) / (2 * cell);
  const gz = (h[a + n] - h[a - n]) / (2 * cell);
  const s = (gx * 0.75 + gz * 0.66);
  if (s < mn) mn = s; if (s > mx) mx = s;
  const v = Math.max(0, Math.min(255, 128 + s * gain));
  const k = (j * S + i) * 4;
  im.data[k] = im.data[k + 1] = im.data[k + 2] = v; im.data[k + 3] = 255;
}
ctx.putImageData(im, 0, 0);
return { spanM: S * cell, slopeMin: +mn.toFixed(4), slopeMax: +mx.toFixed(4), img: { plan: c.toDataURL('image/png') } };
