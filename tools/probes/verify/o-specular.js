/**
 * OUTPOST SPECULAR — ablated the only way that works on this module.
 *
 * The round-5 probe forced `material.roughness = 1` on every material in the
 * scene and measured no change. On the outpost that ablation is a NO-OP: every
 * outpost surface injects `roughnessFactor = gRough` into the fragment shader,
 * so the material property it was writing is dead code. This drives the
 * module's own `setSpecAblate`, which forces gRough to 1 and gMetal to 0 in the
 * shader itself — i.e. it really does delete the specular lobe and nothing else.
 *
 * Detector is the acceptance one: luma > 180 AND > 2.0x its 17x17 neighbourhood
 * mean AND > 70 codes above it, strictly below the horizon.
 */
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer, pipeline = engine.pipeline;
const gl = renderer.getContext();
const W = pipeline.width, H = pipeline.height;
const px = new Uint8Array(W * H * 4);
const op = g.world.registry.outpostGround;

/** True horizon row (from the top) for a shot, off the live camera matrices. */
function horizonRow() {
  const cam = engine.camera;
  const dir = new g.THREE.Vector3();
  cam.getWorldDirection(dir);
  // A point at eye height infinitely far along the horizontal projection of the
  // view direction: its NDC y is the horizon.
  const p = new g.THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(1e6).add(cam.position);
  p.y = cam.position.y;
  p.project(cam);
  return Math.round((1 - (p.y * 0.5 + 0.5)) * H);
}

function detect(hz) {
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  const R = 8, tmp = new Float32Array(W * H), sum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0;
    for (let x = -R; x <= R; x++) s += L[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = s; s -= L[y * W + Math.min(W - 1, Math.max(0, x - R))]; s += L[y * W + Math.min(W - 1, Math.max(0, x + R + 1))]; } }
  for (let x = 0; x < W; x++) { let s = 0;
    for (let y = -R; y <= R; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) { sum[y * W + x] = s; s -= tmp[Math.min(H - 1, Math.max(0, y - R)) * W + x]; s += tmp[Math.min(H - 1, Math.max(0, y + R + 1)) * W + x]; } }
  const N = (2 * R + 1) * (2 * R + 1);
  // readPixels is bottom-up: rows 0..(H-hz) are below the horizon.
  let all = 0, bright = 0, peak = 0, mean = 0, tot = 0;
  const rows = [];
  for (let y = 0; y < H - hz; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = L[i], m = sum[i] / N;
    tot++; mean += l;
    if (l > peak) peak = l;
    if (l > 180) bright++;
    if (l > 180 && l > 2 * m && l > m + 70) { all++; if (rows.length < 12) rows.push([x, H - 1 - y, +l.toFixed(0)]); }
  }
  return { hits: all, lumaOver180: bright, brightest: +peak.toFixed(0), meanBelow: +(mean / tot).toFixed(1), sample: rows };
}

const out = {};
for (const shot of ['outpost', 'gameplay', 'ground', 'night']) {
  g.applyShot(shot);
  g.settle(12);
  const hz = Math.max(0, Math.min(H - 1, horizonRow()));
  op.setSpecAblate(false); g.settle(10);
  const base = detect(hz);
  op.setSpecAblate(true); g.settle(10);
  const abl = detect(hz);
  op.setSpecAblate(false); g.settle(4);
  out[shot] = { horizonRow: hz, base, ablated: abl, delta: base.hits - abl.hits };
}
return out;
