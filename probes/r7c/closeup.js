// Character close-ups from the LIVE page. Frames the player from a few angles
// at the gameplay time-of-day so the pipeline (exposure, grade, fog) is exactly
// what ships, then also emits a 40 px-tall silhouette-legibility strip.
g.setFreeFly(false);
g.applyShot('gameplay');
g.settle(6);
const engine = g.engine, cam = engine.camera, renderer = engine.renderer;
const player = g.world.registry.characters.player;
const p = player.root.position.clone();
const ground = g.world.registry.characters.ground;
const gy = ground.heightAt(p.x, p.z);

function shoot(name, azDeg, elev, dist, aimY) {
  const a = azDeg * Math.PI / 180;
  cam.position.set(p.x + Math.sin(a) * dist, gy + elev, p.z + Math.cos(a) * dist);
  cam.lookAt(p.x, gy + aimY, p.z);
  cam.updateMatrixWorld(true);
  g.settle(2);
  window.__snaps[name] = renderer.domElement.toDataURL('image/png');
}

// Behind-and-right, the shipped gameplay angle but tight on the upper body.
shoot('c-upper', 25, 1.75, 1.9, 1.45);
// Head and shoulders.
shoot('c-head', 15, 1.80, 1.05, 1.62);
// Three-quarter front, so the weapon, chest rig and face are all visible.
shoot('c-front', 200, 1.55, 2.3, 1.15);
// Full figure, side-on: the silhouette read.
shoot('c-side', 105, 1.10, 3.4, 0.95);
return { pos: p.toArray().map((v) => +v.toFixed(2)), gy: +gy.toFixed(2) };
