// Characterise the vista frame: camera altitude, skyline distance + world Y at
// the measured bands, and the cloud pixels' elevation/range.
g.setFreeFly(false);
const engine = g.engine, renderer = engine.renderer;
const pipeline = engine.pipeline;
const pass = g.world.registry.volumetrics.pass;
g.applyShot('vista');
g.settle(10);
const cam = engine.camera;
const W = pipeline.width, H = pipeline.height;
const out = { camPos: cam.position.toArray().map(v=>+v.toFixed(1)), W, H,
  params: { dustBeta: pass.params.dustBeta, dustHeight: pass.params.dustHeight,
            apGain: pass.params.apGain, cloudBase: pass.params.cloudBase,
            cloudTop: pass.params.cloudTop, cloudFar: pass.params.cloudFar,
            cloudGain: pass.params.cloudGain } };

// raycast-free: use terrain.heightAt along the view ray for skyline geometry
const invVP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
function rayFor(px, py) {
  const ndc = new THREE.Vector3((px / W) * 2 - 1, 1 - (py / H) * 2, 1).applyMatrix4(invVP);
  return ndc.sub(cam.position).normalize();
}
const terrain = g.world.terrain;
function march(rd) {
  let t = 5;
  for (let i = 0; i < 4000 && t < 12000; i++) {
    const p = cam.position.clone().addScaledVector(rd, t);
    const h = terrain.heightAt(p.x, p.z);
    if (p.y <= h) return { t, y: p.y };
    t += Math.max(4, t * 0.004);
  }
  return null;
}
out.bands = [];
for (const x of [270, 710, 1050, 1470, 1770]) {
  // find the skyline row by marching downward from the top
  let sky = null;
  for (let y = 40; y < H - 4; y += 2) {
    const hit = march(rayFor(x, y));
    if (hit) { sky = { row: y, ...hit }; break; }
  }
  const rows = [];
  if (sky) for (const dy of [10, 30, 60, 110]) {
    const hit = march(rayFor(x, sky.row + dy));
    if (hit) rows.push({ dy, dist: Math.round(hit.t), y: Math.round(hit.y) });
  }
  out.bands.push({ x, skylineRow: sky ? sky.row : -1, skyDist: sky ? Math.round(sky.t) : -1,
                   skyY: sky ? Math.round(sky.y) : -1, rows });
}
// how far is the sky elevation of each screen row
out.rowElev = [80, 160, 240, 320, 400].map((y) => ({ y, elevDeg: +(Math.asin(rayFor(960, y).y) * 57.2958).toFixed(2) }));
return out;
