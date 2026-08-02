// How much of the pan's swirling wood grain is the SHADOW MAP?
// Same pose, same frame count, shadow map on then off, high-pass energy over
// the ground band. Also a temporal delta under a 12 cm camera step, which is
// what makes the artefact read as "glitchy" rather than as texture.
const g = window.__GAME;
g.setFreeFly(false);
const engine = g.engine, cam = engine.camera, gl = engine.renderer.getContext();
const W = engine.pipeline.width, H = engine.pipeline.height;
g.setTimeOfDay('afternoon');
function pose(dz) {
  cam.fov = 62; cam.position.set(-260, 38, 420 + dz); cam.lookAt(-120, 8, 60);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
}
function grab() {
  g.settle(14);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
function measure(a, b) {
  let n = 0, sd = 0, hp = 0, nh = 0, mean = 0;
  for (let y = Math.round(0.55 * H); y < Math.round(0.92 * H); y++) {
    const row = H - 1 - y;
    for (let x = 10; x < W - 10; x++) {
      const i = (row * W + x) * 4;
      const d = lum(a, i) - lum(b, i);
      sd += d * d; mean += lum(a, i); n++;
      if (x % 2 === 0) { const h = lum(a, i) - 0.5 * (lum(a, i - 8) + lum(a, i + 8)); hp += h * h; nh++; }
    }
  }
  return { mean: +(mean / n).toFixed(1), dRMS: +Math.sqrt(sd / n).toFixed(3), hpRMS: +Math.sqrt(hp / nh).toFixed(3) };
}
const out = {};
pose(0); const a1 = grab(); pose(0.12); out.shadowsOn = measure(a1, grab());
engine.renderer.shadowMap.enabled = false;
engine.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
pose(0); const a2 = grab(); pose(0.12); out.shadowsOff = measure(a2, grab());
return out;
