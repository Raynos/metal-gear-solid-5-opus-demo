// Diagnose the ablation noise floor: how much does the frame move when we hide
// something tiny, or nothing at all?
const eng = g.engine;
const gl = eng.renderer.getContext();
const pipe = eng.pipeline;

function grab() {
  g.settle(6);
  const s = eng.renderer.getSize(new THREE.Vector3());
  const w = s.x | 0; const h = s.y | 0;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
}
function hist(A, B) {
  const n = A.w * A.h;
  const H = new Array(12).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(A.px[o] - B.px[o]), Math.abs(A.px[o + 1] - B.px[o + 1]), Math.abs(A.px[o + 2] - B.px[o + 2]));
    sum += d;
    H[Math.min(11, d)]++;
  }
  return { mean: +(sum / n).toFixed(3), hist: H.map((c) => +((c / n) * 100).toFixed(2)) };
}

const out = {};
g.applyShot('outpost');
const a1 = grab();
const a2 = grab();
out.repeat = hist(a1, a2);
pipe.enabled.autoExposure = false;
const b1 = grab();
const b2 = grab();
out.repeatNoAE = hist(b1, b2);
const rocks = g.world.registry.rocks;
rocks.group.visible = false;
const b3 = grab();
rocks.group.visible = true;
out.rocksOffNoAE = hist(b1, b3);
out.exposureInfo = pipe.exposureInfo;
return out;
