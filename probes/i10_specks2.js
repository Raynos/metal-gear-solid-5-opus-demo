/**
 * i10_specks2.js — which object draws the bright specks inside the cast shadow,
 * and does it receive the shadow at all?
 *
 *   node tools/probe.mjs probes/i10_specks2.js
 *
 * i10_specks.js established the band is a cast shadow (ablating the traffic
 * block moved nothing) and that the specks on it reach p98 162 against a
 * shadowed surface at p30 25 — i.e. full sunlit value inside a shadow. This
 * hides each candidate in turn and reports which one takes the specks with it.
 */

const g = window.__GAME;
const eng = g.world.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();

const canvas = renderer.domElement;
const W = canvas.width;
const H = canvas.height;
const RX = Math.round((1000 / 1920) * W);
const RW = Math.round((220 / 1920) * W);
const RY = Math.round((700 / 1080) * H);
const RH = Math.round((100 / 1080) * H);

function readBand() {
  const y = H - (RY + RH);
  const px = new Uint8Array(RW * RH * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(RX, y, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const lum = [];
  let bright = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    lum.push(l);
    if (l > 100) bright++;
  }
  lum.sort((a, b) => a - b);
  const q = (f) => +lum[Math.min(lum.length - 1, Math.floor(f * lum.length))].toFixed(1);
  return { p30: q(0.3), p50: q(0.5), p98: q(0.98), fracOver100: +(bright / lum.length).toFixed(4) };
}

// Collect candidates by name.
const groups = { clast: [], grass: [], scrub: [], rock: [], other: [] };
g.world.scene.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  const n = (o.name || '').toLowerCase();
  if (n.includes('clast')) groups.clast.push(o);
  else if (n.includes('grass')) groups.grass.push(o);
  else if (n.includes('scrub') || n.includes('bush')) groups.scrub.push(o);
  else if (n.includes('rock') || n.includes('talus') || n.includes('stone')) groups.rock.push(o);
});

const out = { counts: {}, table: {} };
for (const k of Object.keys(groups)) out.counts[k] = groups[k].length;

g.applyShot('ground');
g.settle(8);
out.table.baseline = readBand();

for (const k of ['clast', 'grass', 'scrub', 'rock']) {
  if (!groups[k].length) continue;
  groups[k].forEach((o) => (o.visible = false));
  g.settle(6);
  out.table['hide_' + k] = readBand();
  groups[k].forEach((o) => (o.visible = true));
  g.settle(2);
}

// Find the directional light actually casting, whatever it is called.
const lights = [];
g.world.scene.traverse((o) => {
  if (o.isDirectionalLight) {
    lights.push({ name: o.name, castShadow: o.castShadow, intensity: +o.intensity.toFixed(3) });
  }
});
out.directionalLights = lights;

// Shadow ablation, via the renderer rather than a named light.
const wasShadow = renderer.shadowMap.enabled;
renderer.shadowMap.enabled = false;
g.settle(8);
out.table.noShadowMap = readBand();
renderer.shadowMap.enabled = wasShadow;
g.settle(6);

return out;
