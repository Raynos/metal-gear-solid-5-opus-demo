// What draws the object at a given screen pixel? Raycast through a grid of
// pixels in the `ground` shot and report the hit object's name / ancestry.
//
// `--hide` answers "which system" by difference but needs a candidate name to
// hide. This gets the name.
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine;
g.applyShot('ground');
g.settle(4);
const cam = eng.camera;
const W = 1920;
const H = 1080;
const rc = new THREE.Raycaster();
rc.far = 400;
const hits = {};
const box = JSON.parse(ARGS[0] || '[120,640,400,780]'); // x0,y0,x1,y1
for (let py = box[1]; py <= box[3]; py += 6) {
  for (let px = box[0]; px <= box[2]; px += 6) {
    const ndc = new THREE.Vector2((px / W) * 2 - 1, -(py / H) * 2 + 1);
    rc.setFromCamera(ndc, cam);
    const is = rc.intersectObject(g.world.scene, true);
    if (!is.length) continue;
    const o = is[0].object;
    const chain = [];
    let p = o;
    for (let i = 0; i < 4 && p; i++, p = p.parent) chain.push(p.name || `(${p.type})`);
    const key = chain.join(' < ');
    hits[key] = (hits[key] || 0) + 1;
  }
}
return Object.entries(hits).sort((a, b) => b[1] - a[1]).slice(0, 25);
