// Is the hair shell actually VISIBLE, or is it buried / back-faced?
// Paints cloth zone 16 (hair) pure red and zone 11 (bandana) pure blue on the
// player's own material instance, then shoots the head. Anything the camera can
// see is unambiguous; anything it cannot is not there.
g.setFreeFly(false);
g.applyShot('gameplay');
g.settle(6);
const engine = g.engine, cam = engine.camera, renderer = engine.renderer;
const player = g.world.registry.characters.player;
const p = player.root.position.clone();
const gy = g.world.registry.characters.ground.heightAt(p.x, p.z);
const u = player.materials.cloth.userData.uniforms;
const save = u.uZoneColor.value.map((v) => v.clone());

function shoot(name) {
  const a = 15 * Math.PI / 180;
  cam.position.set(p.x + Math.sin(a) * 1.05, gy + 1.80, p.z + Math.cos(a) * 1.05);
  cam.lookAt(p.x, gy + 1.62, p.z);
  cam.updateMatrixWorld(true);
  g.settle(2);
  window.__snaps[name] = renderer.domElement.toDataURL('image/png');
}
shoot('zp-before');
u.uZoneColor.value[16].set(1.0, 0.0, 0.0);
u.uZoneColor.value[11].set(0.0, 0.0, 1.0);
u.uZoneColor.value[13].set(0.0, 1.0, 0.0);
shoot('zp-after');
for (let i = 0; i < save.length; i++) u.uZoneColor.value[i].copy(save[i]);
g.settle(1);
return { ok: true };
