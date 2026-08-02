/**
 * shimmer3.js — separate the mountain-band instability from the FILM GRAIN
 * floor, and measure the ridge SILHOUETTE directly.
 *
 *   probes/run.sh probes/shimmer3.js
 *
 * shimmer2 showed d2/d1 = 1.75 in the band, which is exactly sqrt(3) — the
 * signature of per-pixel white noise, not of geometry. So the per-pixel metric
 * everyone has been quoting is measuring the composite's film grain. This probe
 * quotes four numbers instead:
 *   staticGrain  camera frozen, grain on   -> the noise floor
 *   staticClean  camera frozen, grain off  -> should be ~0
 *   flyGrain     flying, grain on          -> what was being reported
 *   flyClean     flying, grain off         -> the real instability
 * and then tracks the ridge silhouette row per column, which is what "the
 * mountains are unstable" actually describes.
 */

const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const cam = eng.camera;
const gl = eng.renderer.getContext();

g.applyShot('vista');
g.settle(6);

const size = eng.renderer.getSize(new THREE.Vector2());
const W = Math.floor(size.x * eng.renderer.getPixelRatio());
const H = Math.floor(size.y * eng.renderer.getPixelRatio());

const ALT = 240;
const bandTop = Math.floor(H * 0.30);
const bandH = Math.floor(H * 0.26);
const bandY = H - bandTop - bandH;

const bufs = [new Uint8Array(W * bandH * 4), new Uint8Array(W * bandH * 4), new Uint8Array(W * bandH * 4)];

const base = new THREE.Vector3(-64, ALT, 400);
const fwd = new THREE.Vector3(0.12, -0.06, -1).normalize();

function pose(i, speed) {
  cam.position.copy(base).addScaledVector(fwd, (i * speed) / 60);
  cam.lookAt(cam.position.x + fwd.x * 100, cam.position.y + fwd.y * 100 + 4, cam.position.z + fwd.z * 100);
  cam.updateMatrixWorld();
}

const pipe = eng.pipeline;

/**
 * Silhouette row of the sky/terrain boundary for each column, found by scanning
 * down the band for the first big vertical luminance step. Sub-pixel is not
 * needed: a stable ridge holds the SAME integer row for many frames while the
 * camera translates slowly, and a snapping lattice moves it by whole pixels.
 */
function silhouette(buf) {
  const rows = new Int16Array(W);
  for (let x = 0; x < W; x++) {
    rows[x] = -1;
    // readPixels is bottom-up, so walk from the TOP of the band downwards.
    for (let y = bandH - 1; y > 0; y--) {
      const i = (y * W + x) * 4;
      const j = ((y - 1) * W + x) * 4;
      const l0 = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      const l1 = 0.2126 * buf[j] + 0.7152 * buf[j + 1] + 0.0722 * buf[j + 2];
      if (l0 - l1 > 8) {
        rows[x] = y;
        break;
      }
    }
  }
  return rows;
}

function run(speed, grain, wantSil) {
  const savedGrain = pipe.grade.grainAmount;
  if (!grain) pipe.grade.grainAmount = 0;
  eng.deterministic = true;
  for (let i = 0; i < 14; i++) {
    pose(i, speed);
    eng.step(1 / 60);
    eng.render();
  }
  let d1 = 0;
  let d1n = 0;
  let d2 = 0;
  let d2n = 0;
  let worst = 0;
  let silSum = 0;
  let silN = 0;
  let silMax = 0;
  let prevSil = null;
  const N = 50;
  for (let i = 14; i < 14 + N; i++) {
    pose(i, speed);
    eng.step(1 / 60);
    eng.render();
    const k = (i - 14) % 3;
    gl.readPixels(0, bandY, W, bandH, gl.RGBA, gl.UNSIGNED_BYTE, bufs[k]);
    const a = bufs[(k + 1) % 3];
    const b = bufs[(k + 2) % 3];
    const c = bufs[k];
    if (i - 14 >= 1) {
      let s = 0;
      for (let p = 0; p < c.length; p += 4) {
        const d = Math.abs(c[p] - b[p]) + Math.abs(c[p + 1] - b[p + 1]) + Math.abs(c[p + 2] - b[p + 2]);
        s += d;
        if (d > worst) worst = d;
      }
      d1 += s / (c.length / 4);
      d1n++;
    }
    if (i - 14 >= 2) {
      let s = 0;
      for (let p = 0; p < c.length; p += 4) {
        s +=
          Math.abs(c[p] - 2 * b[p] + a[p]) +
          Math.abs(c[p + 1] - 2 * b[p + 1] + a[p + 1]) +
          Math.abs(c[p + 2] - 2 * b[p + 2] + a[p + 2]);
      }
      d2 += s / (c.length / 4);
      d2n++;
    }
    if (wantSil) {
      const sil = silhouette(c);
      if (prevSil) {
        // Second difference again: smooth ridge drift under translation is
        // legitimate; a ridge that moves and comes back is not.
        for (let x = 0; x < W; x++) {
          if (sil[x] < 0 || prevSil[x] < 0) continue;
          const d = Math.abs(sil[x] - prevSil[x]);
          silSum += d;
          silN++;
          if (d > silMax) silMax = d;
        }
      }
      prevSil = sil;
    }
  }
  pipe.grade.grainAmount = savedGrain;
  const r = {
    d1: +(d1 / Math.max(d1n, 1)).toFixed(2),
    d2: +(d2 / Math.max(d2n, 1)).toFixed(2),
    worst,
  };
  if (wantSil) {
    r.silMeanRowJump = +(silSum / Math.max(silN, 1)).toFixed(3);
    r.silMaxRowJump = silMax;
  }
  return r;
}

const out = {};
out.staticGrain = run(0, true, false);
out.staticClean = run(0, false, false);
out.flyGrain = run(30, true, true);
out.flyClean = run(30, false, true);

// Grain-free flight with the clipmap re-centre frozen: if the ridge silhouette
// settles, the lattice snap is the cause.
const terr = g.world.terrain;
if (terr && typeof terr._recenter === 'function') {
  const saved = terr._recenter;
  terr._recenter = () => {};
  out.flyCleanClipmapFrozen = run(30, false, true);
  terr._recenter = saved;
  terr._cx = NaN;
}

if (pipe.enabled.taa) {
  pipe.enabled.taa = false;
  out.flyCleanNoTAA = run(30, false, true);
  pipe.enabled.taa = true;
}

return out;
