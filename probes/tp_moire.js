// Which layer draws the swirling paisley on the pan?
//
// The user's video shows concentric wood-grain swirls across the valley floor
// that MOVE WITH THE CAMERA. That is aliasing, not texture, so the honest
// measurement is a temporal one: settle the frame, translate the camera by a
// fraction of a pixel of ground motion, settle again, and take the RMS
// difference over the ground band. A layer that is correctly resolved barely
// moves; a layer being sampled under its own Nyquist rate changes completely.
//
// Every candidate already has an ablation switch:
//   uDbg  = (strata, near grit, wind ripples, varnish)
//   uDbg2 = (mid-field pavement, albedo swing, varnish probe, mask readout)
const g = window.__GAME;
g.setFreeFly(false);
const engine = g.engine;
const cam = engine.camera;
const gl = engine.renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;
const U = g.world?.terrain?.uniforms;
if (!U) return { error: 'no terrain uniforms' };

g.setTimeOfDay('afternoon');

// The video is a free-flight over the open pan: high, wide, looking across a
// long stretch of flat ground. That is the sampling regime the canonical shots
// never enter — `ground` is 1.7 m up and `vista` looks at a ridge.
const POSES = {
  p1: { eye: [-40, 26, 150], aim: [30, 12, -120], fov: 55 },
  p2: { eye: [-260, 38, 420], aim: [-120, 8, 60], fov: 62 },
  p3: { eye: [420, 55, 520], aim: [180, 10, 60], fov: 62 },
  p4: { eye: [-600, 70, -300], aim: [-200, 10, -60], fov: 62 },
};
let P = POSES.p1;
function pose(dz) {
  cam.fov = P.fov;
  cam.position.set(P.eye[0], P.eye[1], P.eye[2] + dz);
  cam.lookAt(P.aim[0], P.aim[1], P.aim[2]);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

function grab() {
  g.settle(10);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
const shot = () => engine.renderer.domElement.toDataURL('image/jpeg', 0.85);

// The ground band of these framings: below the ridgeline, above the very near
// field. Rows are counted from the TOP of the image; readPixels is bottom-up.
const Y0 = 0.55, Y1 = 0.92;
const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

function measure(a, b) {
  let n = 0, sd = 0, hp = 0, nh = 0;
  for (let y = Math.round(Y0 * H); y < Math.round(Y1 * H); y++) {
    const row = H - 1 - y;
    for (let x = 10; x < W - 10; x++) {
      const i = (row * W + x) * 4;
      const d = lum(a, i) - lum(b, i);
      sd += d * d; n++;
      // 3-tap high-pass at 8 px: the swirl bands are 8-40 px, so this is a
      // proxy for "how much structure is in a surface that should be smooth".
      if (x % 2 === 0) {
        const h = lum(a, i) - 0.5 * (lum(a, i - 8) + lum(a, i + 8));
        hp += h * h; nh++;
      }
    }
  }
  return { dRMS: +Math.sqrt(sd / n).toFixed(3), hpRMS: +Math.sqrt(hp / nh).toFixed(3) };
}

const MODE = (ARGS || [])[0] || 'poses';
const out = {}, img = {};

if (MODE === 'poses') {
  for (const k of Object.keys(POSES)) {
    P = POSES[k];
    pose(0);
    const a = grab();
    img[k] = shot();
    pose(0.12);
    out[k] = measure(a, grab());
  }
} else {
  P = POSES[MODE] || POSES.p1;
  const CONFIGS = [
    ['base',       [1, 1, 1, 1], 1],
    ['noRipple',   [1, 1, 0, 1], 1],
    ['noGrit',     [1, 0, 1, 1], 1],
    ['noPavement', [1, 1, 1, 1], 0],
    ['noStrata',   [0, 1, 1, 1], 1],
    ['noneOfIt',   [0, 0, 0, 1], 0],
  ];
  const want = new Set((ARGS || []).slice(1));
  for (const [name, dbg, pav] of CONFIGS) {
    U.uDbg.value.set(dbg[0], dbg[1], dbg[2], dbg[3]);
    U.uDbg2.value.x = pav;
    pose(0);
    const a = grab();
    if (want.has(name)) img[name] = shot();
    pose(0.12);
    out[name] = measure(a, grab());
  }
  U.uDbg.value.set(1, 1, 1, 1);
  U.uDbg2.value.x = 1;
}
return { out, img };
