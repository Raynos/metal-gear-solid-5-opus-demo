// Smoke test for lighting.addNearShadowCaster: a caster inside the near split
// keeps casting, one the camera has left behind stops, and unregistering hands
// the object back exactly as it arrived.
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const lighting = g.world.lighting;
g.applyShot('gameplay');
g.settle(6);

const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
near.castShadow = true;
near.position.copy(eng.camera.position).add(new THREE.Vector3(0, -1, 0));
const far = near.clone();
far.castShadow = true;
far.position.copy(eng.camera.position).add(new THREE.Vector3(600, 0, 0));
eng.scene.add(near, far);

lighting.addNearShadowCaster(near);
lighting.addNearShadowCaster(far);
g.settle(10);
const after = { nearCasts: near.castShadow, farCasts: far.castShadow, split: +lighting.nearShadowDistance.toFixed(1) };

lighting.removeNearShadowCaster(far);
g.settle(6);
const restored = far.castShadow;

// An object that was never a caster must not become one.
const notACaster = near.clone();
notACaster.castShadow = false;
notACaster.position.copy(near.position);
eng.scene.add(notACaster);
lighting.addNearShadowCaster(notACaster);
g.settle(10);
const stayedOff = notACaster.castShadow === false;

lighting.removeNearShadowCaster(near);
lighting.removeNearShadowCaster(notACaster);
eng.scene.remove(near, far, notACaster);
return { ...after, farRestoredOnRemove: restored, nonCasterStayedOff: stayedOff, registrySize: (lighting._nearCasters || []).length };
