/**
 * r11_shadowmap.js — read the cascade depth map and say WHERE the blocker is.
 *
 * probes/r11_shadowcaster.js raycast straight up the sun from inside the black
 * polygon in the canonical `ground` frame and hit nothing at all, while TODO 1.3 says the
 * blob disappears with shadowMap.enabled = false. Both cannot be true unless
 * the shadow map holds a blocker that no scene geometry actually puts there.
 *
 * So: unpack cascade 0's own depth texture at the receiver's shadow UV and
 * convert it back into a world position along the light ray. That gives the
 * ALTITUDE of whatever the depth pass rasterised, which is enough to name it —
 * "1.4 m up" is a net, "0.02 m up" is the receiver shadowing itself, and
 * "unpacked depth 1.0" is an empty map.
 */
const g = window.__GAME;
const THREE = g.THREE;
const world = g.world;
const lighting = world.lighting;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
for (let i = 0; i < 8; i++) { g.engine.step(1 / 60); g.engine.render(); }
const cam = g.engine.camera;
cam.updateMatrixWorld();

const renderer = g.engine.renderer;
const W = 1920, H = 1080;
const PIX = [
  ['blob-left', 950, 740],
  ['blob-mid', 1150, 775],
  ['blob-edge-lit', 1150, 830],
  ['tarp-black', 1660, 760],
  ['lit-control', 1100, 930],
];

const rc = new THREE.Raycaster();
const key = lighting.keyDirection.clone();
const out = [];

// The inverse of three's packDepthToRGBA: dot(rgba, vec4(1, 1/255, 1/65025,
// 1/16581375)). The error against the shifted-subtract form is < 1e-7, which is
// four orders below the depth differences this probe is looking for.
function unpack(b) {
  return b[0] / 255 + b[1] / 255 / 255 + b[2] / 255 / 65025 + b[3] / 255 / 16581375;
}

for (const [name, px, py] of PIX) {
  const ndc = new THREE.Vector2((px / W) * 2 - 1, -((py / H) * 2 - 1));
  rc.setFromCamera(ndc, cam);
  const hits = rc.intersectObjects(world.scene.children, true).filter((h) => h.object.visible);
  if (!hits.length) { out.push({ name, err: 'no receiver' }); continue; }
  const p = hits[0].point.clone();
  const rec = { name, receiver: hits[0].object.name || '(unnamed)', world: p.toArray().map((v) => +v.toFixed(2)), cascades: [] };

  for (let c = 0; c < lighting.cascadeCount; c++) {
    const light = lighting.cascades[c];
    const map = light.shadow.map;
    if (!map) { rec.cascades.push({ c, err: 'no map' }); continue; }
    const sc = p.clone().applyMatrix4(light.shadow.matrix);
    // shadow.matrix output is already the biased [0,1] coord (w = 1 for ortho).
    const u = sc.x, v = sc.y, z = sc.z;
    if (u < 0 || u > 1 || v < 0 || v > 1 || z < 0 || z > 1) {
      rec.cascades.push({ c, outside: true, uv: [+u.toFixed(3), +v.toFixed(3)], z: +z.toFixed(5) });
      continue;
    }
    const size = light.shadow.mapSize.x;
    const sx = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
    const sy = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
    const buf = new Uint8Array(4);
    renderer.readRenderTargetPixels(map, sx, sy, 1, 1, buf);
    const zb = unpack(buf);
    const cm = light.shadow.camera;
    const range = cm.far - cm.near;
    // Ortho: world distance from the shadow camera = near + z * range.
    const dRec = cm.near + z * range;
    const dBlk = cm.near + zb * range;
    // How far ABOVE the receiver, along the light, the blocker sits.
    const above = dRec - dBlk;
    rec.cascades.push({
      c,
      uv: [+u.toFixed(4), +v.toFixed(4)],
      zRecv: +z.toFixed(6),
      zBlocker: +zb.toFixed(6),
      rgba: Array.from(buf),
      blockerAboveM: +above.toFixed(3),
      biasZ: +light.shadow.bias.toFixed(7),
      biasM: +(light.shadow.bias * range).toFixed(3),
      normalBias: +light.shadow.normalBias.toFixed(4),
      texelM: +((cm.right - cm.left) / size).toFixed(4),
      penumbraK: +light.shadow.radius.toFixed(2),
      depthRangeM: +range.toFixed(1),
      shadowed: zb < z + light.shadow.bias,
    });
  }
  out.push(rec);
}

return { keyDir: key.toArray().map((v) => +v.toFixed(3)), samples: out };
