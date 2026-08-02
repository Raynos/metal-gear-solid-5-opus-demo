// Two legibility tests, both by rendering a flat silhouette mask and
// downsampling it — no eyeballing.
//
//  1. THE 40 px TEST. The player, box-cropped and reduced to 40 px tall, so the
//     round-8 silhouette furniture (the ponytail and the back-slung weapon) can
//     be shown to survive or shown not to. Reported as ASCII art plus a
//     quantitative "furniture" figure: cells that are outside the core body
//     column, which is what makes a figure a SPECIFIC soldier rather than a
//     soldier-shaped blob.
//
//  2. THE COMMANDER AT 60 m. The commander and a patrol guard are rendered
//     alone at the same distance and downsampled to the same height, and their
//     masks are differenced. If two figures cannot be told apart at the range
//     the AI expects the player to identify a target at, the kit is decoration.
//     Also reports the beauty-pass mean luminance of each, because at 40 px the
//     first thing that separates two figures is value, not shape.
g.setFreeFly(false);
g.applyShot('gameplay');
g.settle(6);
const engine = g.engine, scene = engine.scene, renderer = engine.renderer;
const pipeline = engine.pipeline;
const reg = g.world.registry.characters;
const cam = engine.camera;
const W = pipeline.width, H = pipeline.height;

const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: true });
const buf = new Uint8Array(W * H * 4);
const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function maskOf(root, mat) {
  const hidden = [];
  scene.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
      let p = o, keep = false;
      while (p) { if (p === root) { keep = true; break; } p = p.parent; }
      if (o.visible !== keep) { hidden.push([o, o.visible]); o.visible = keep; }
    }
  });
  const bg = scene.background; scene.background = null;
  if (mat) scene.overrideMaterial = mat;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(scene, cam);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  renderer.setRenderTarget(prev);
  scene.overrideMaterial = null; scene.background = bg;
  for (const [o, v] of hidden) o.visible = v;
  return buf.slice();
}

/** Box-crop a mask and resample to `TH` rows of coverage fractions. */
function shrink(px, TH) {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = px[i * 4] > 60 ? 1 : 0;
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const TW = Math.max(1, Math.round((bw / bh) * TH));
  const cov = new Float32Array(TW * TH);
  for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
    let n = 0, tot = 0;
    const sy1 = y1 - Math.floor((ty / TH) * bh), sy0 = y1 - Math.floor(((ty + 1) / TH) * bh);
    const sx0 = x0 + Math.floor((tx / TW) * bw), sx1 = x0 + Math.floor(((tx + 1) / TW) * bw);
    for (let y = Math.max(y0, sy0); y <= Math.min(y1, sy1); y++) for (let x = sx0; x < Math.max(sx0 + 1, sx1); x++) {
      tot++; if (m[y * W + x]) n++;
    }
    cov[ty * TW + tx] = tot ? n / tot : 0;
  }
  return { cov, TW, TH, bboxPx: [bw, bh] };
}
const art = (s) => {
  let out = '';
  for (let y = 0; y < s.TH; y++) {
    for (let x = 0; x < s.TW; x++) {
      const f = s.cov[y * s.TW + x];
      out += f > 0.6 ? '#' : f > 0.25 ? '+' : f > 0.05 ? '.' : ' ';
    }
    out += '\n';
  }
  return out;
};

const out = {};

// ---- 1. the player at 40 px ----------------------------------------------
{
  const s = shrink(maskOf(reg.player.root, flat), 40);
  // "Furniture": filled cells that lie outside the widest contiguous run of the
  // torso rows, i.e. outline events that are not just "a body".
  let core = 0;
  for (let y = 12; y < 26; y++) {
    let run = 0, best = 0;
    for (let x = 0; x < s.TW; x++) {
      if (s.cov[y * s.TW + x] > 0.25) { run++; if (run > best) best = run; } else run = 0;
    }
    core += best;
  }
  const coreAvg = core / 14;
  let filled = 0;
  for (let i = 0; i < s.cov.length; i++) if (s.cov[i] > 0.25) filled++;
  out.player40 = {
    bboxPx: s.bboxPx, grid: [s.TW, s.TH],
    filledCells: filled,
    torsoCoreWidthCells: +coreAvg.toFixed(2),
    fillFraction: +(filled / (s.TW * s.TH)).toFixed(3),
    art: art(s),
  };
}

// ---- 2. commander vs guard, both at 60 m ---------------------------------
const commander = reg.commander ?? reg.characters.find((c) => c.role === 'commander');
const guard = reg.characters.find((c) => c !== commander && !c.isPlayer);
if (commander && guard) {
  const saveCam = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov };
  const ground = reg.ground;
  function shotAt(ch, dist, TH) {
    const p = ch.root.position;
    const gy = ground.heightAt(p.x, p.z);
    // Look at him from his own front-left quarter, eye height, from `dist`.
    const a = ch.yaw + Math.PI + 0.6;
    cam.position.set(p.x + Math.sin(a) * dist, gy + 1.62, p.z + Math.cos(a) * dist);
    cam.lookAt(p.x, gy + 0.95, p.z);
    cam.fov = 45;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    g.settle(2);
    const mk = maskOf(ch.root, flat);
    const beauty = maskOf(ch.root, null);
    let n = 0, sum = 0, r = 0, gg = 0, b = 0;
    for (let i = 0; i < W * H; i++) {
      if (mk[i * 4] <= 60) continue;
      n++;
      r += beauty[i * 4]; gg += beauty[i * 4 + 1]; b += beauty[i * 4 + 2];
      sum += 0.2126 * beauty[i * 4] + 0.7152 * beauty[i * 4 + 1] + 0.0722 * beauty[i * 4 + 2];
    }
    return { s: shrink(mk, TH), px: n, meanSrgb: n ? +(sum / n).toFixed(1) : 0, rgb: n ? [r / n, gg / n, b / n].map((v) => +v.toFixed(1)) : null };
  }
  const c60 = shotAt(commander, 60, 40);
  const g60 = shotAt(guard, 60, 40);
  // Silhouette difference, resampled onto the commander's grid.
  let diff = 0, tot = 0;
  if (c60.s && g60.s) {
    for (let y = 0; y < 40; y++) for (let x = 0; x < c60.s.TW; x++) {
      const gx = Math.min(g60.s.TW - 1, Math.round((x / c60.s.TW) * g60.s.TW));
      const a = c60.s.cov[y * c60.s.TW + x] > 0.25 ? 1 : 0;
      const b2 = g60.s.cov[y * g60.s.TW + gx] > 0.25 ? 1 : 0;
      tot++; if (a !== b2) diff++;
    }
  }
  out.commanderVsGuardAt60m = {
    commander: { heightPx: c60.s?.bboxPx[1], widthPx: c60.s?.bboxPx[0], maskPx: c60.px, meanSrgb: c60.meanSrgb, rgb: c60.rgb },
    guard: { heightPx: g60.s?.bboxPx[1], widthPx: g60.s?.bboxPx[0], maskPx: g60.px, meanSrgb: g60.meanSrgb, rgb: g60.rgb },
    silhouetteDisagreementPct: tot ? +((diff / tot) * 100).toFixed(1) : null,
    valueStopsCommanderOverGuard: c60.meanSrgb && g60.meanSrgb
      ? +Math.log2(c60.meanSrgb / g60.meanSrgb).toFixed(2) : null,
    widthRatio: c60.s && g60.s ? +(c60.s.bboxPx[0] / g60.s.bboxPx[0]).toFixed(2) : null,
    commanderArt: c60.s ? art(c60.s) : null,
    guardArt: g60.s ? art(g60.s) : null,
  };
  cam.position.copy(saveCam.p); cam.quaternion.copy(saveCam.q); cam.fov = saveCam.fov;
  cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  g.settle(2);
} else {
  out.commanderVsGuardAt60m = { error: 'no commander in the cast' };
}
rt.dispose();
return out;
