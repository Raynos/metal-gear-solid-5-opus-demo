/**
 * How much of the scene's own chroma survives the print, measured on the same
 * pixels: a linear-HDR forward render of the shot camera vs the presented frame.
 */
const engine = g.engine, renderer = engine.renderer, gl = renderer.getContext();
const W = 1920, H = 1080;
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace, depthBuffer: true });
const fb = new Float32Array(W * H * 4);
const bb = new Uint8Array(W * H * 4);
const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const out = {};
// x, yTopLeft, w, h  (image coords, y down)
const RECTS = { night: { ground: [900, 900, 400, 150], sky: [900, 120, 300, 120] },
                ridge: { fgShade: [900, 900, 400, 150], midHaze: [1450, 480, 250, 90] } };
for (const shot of ['night', 'ridge']) {
  g.applyShot(shot);
  g.settle(12);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bb);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt); renderer.clear(); renderer.render(engine.scene, engine.camera);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, fb);
  renderer.setRenderTarget(prev);
  const r = {};
  for (const [name, [x0, yTop, w, h]] of Object.entries(RECTS[shot])) {
    let dr = 0, dg = 0, db = 0, lr = 0, lg = 0, lb = 0, n = 0;
    for (let y = yTop; y < yTop + h; y++) for (let x = x0; x < x0 + w; x++) {
      const gy = H - 1 - y;
      const i = (gy * W + x) * 4;
      dr += srgb(bb[i] / 255); dg += srgb(bb[i + 1] / 255); db += srgb(bb[i + 2] / 255);
      lr += fb[i]; lg += fb[i + 1]; lb += fb[i + 2];
      n++;
    }
    r[name] = {
      sceneLinear: [lr / n, lg / n, lb / n].map((v) => +v.toFixed(5)),
      sceneBoverR: +(lb / lr).toFixed(3),
      displayLinear: [dr / n, dg / n, db / n].map((v) => +v.toFixed(5)),
      displayBoverR: +(db / dr).toFixed(3),
    };
  }
  out[shot] = r;
}
rt.dispose();
return out;
