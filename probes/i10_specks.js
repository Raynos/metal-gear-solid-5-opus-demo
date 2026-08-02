/**
 * i10_specks.js — why are the pebbles on the dark band still bright?
 *
 *   node tools/probe.mjs probes/i10_specks.js
 *
 * The ground shot has a long dark band across the mid ground with pale clast
 * scattered over it, and the clast reads at nearly its full sunlit value. Two
 * candidate explanations and they want different fixes:
 *
 *   - the band is a CAST SHADOW and the clast is not receiving it (a bug), or
 *   - the band is the traffic block's oil spill, in which case a stone lying on
 *     it is genuinely in full sun and the render is right.
 *
 * Ablate each cause and read the band back.
 */

const g = window.__GAME;
const eng = g.world.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();

g.applyShot('ground');
g.settle(8);

const canvas = renderer.domElement;
const W = canvas.width;
const H = canvas.height;

// The band, in the 1920x1080 frame the crops were cut from.
const RX = Math.round((1000 / 1920) * W);
const RW = Math.round((220 / 1920) * W);
const RY = Math.round((700 / 1080) * H);
const RH = Math.round((100 / 1080) * H);

function readBand() {
  // readPixels is bottom-up.
  const y = H - (RY + RH);
  const px = new Uint8Array(RW * RH * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(RX, y, RW, RH, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const lum = [];
  for (let i = 0; i < px.length; i += 4) {
    lum.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
  }
  lum.sort((a, b) => a - b);
  const q = (f) => +lum[Math.min(lum.length - 1, Math.floor(f * lum.length))].toFixed(1);
  // The band is bimodal: dark surface plus bright specks. The gap between the
  // 30th and the 98th percentile IS the artefact.
  return { p05: q(0.05), p30: q(0.30), p50: q(0.5), p90: q(0.9), p98: q(0.98) };
}

const terrainU = g.world.terrain?.uniforms ?? g.world.terrain?.material?.userData?.u ?? null;
const sun = eng.lighting?.sun ?? null;

const out = { rect: [RX, RY, RW, RH], haveTerrainU: !!terrainU, haveSun: !!sun };

out.baseline = readBand();

if (terrainU?.uDbg3) {
  terrainU.uDbg3.value.y = 0;          // traffic + spill off
  g.settle(6);
  out.noTraffic = readBand();
  terrainU.uDbg3.value.y = 1;
}

if (sun) {
  const was = sun.castShadow;
  sun.castShadow = false;
  g.settle(6);
  out.noSunShadow = readBand();
  sun.castShadow = was;
  g.settle(4);
}

// And: do the clast meshes claim to receive shadows, and are they in a cascade?
const clast = [];
g.world.scene.traverse((o) => {
  if (/clast/i.test(o.name || '')) {
    clast.push({
      name: o.name,
      visible: o.visible,
      receiveShadow: o.receiveShadow,
      castShadow: o.castShadow,
      count: o.count ?? null,
      isInstanced: !!o.isInstancedMesh,
      hasCustomDepth: !!o.customDepthMaterial,
    });
  }
});
out.clast = clast;

return out;
