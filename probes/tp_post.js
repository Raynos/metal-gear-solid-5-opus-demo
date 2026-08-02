// Is the pan's swirl a SCREEN-SPACE effect? Ablate the pipeline's own passes.
const g = window.__GAME;
g.setFreeFly(false);
const engine = g.engine, cam = engine.camera, P = engine.pipeline;
g.setTimeOfDay('afternoon');
cam.fov = 62; cam.position.set(-260, 38, 420); cam.lookAt(-120, 8, 60);
cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
const name = (ARGS || ['base'])[0];
const saved = { ...P.enabled };
if (name !== 'base') P.enabled[name] = false;
g.settle(12);
const img = { [name]: engine.renderer.domElement.toDataURL('image/jpeg', 0.8) };
Object.assign(P.enabled, saved);
return { keys: Object.keys(saved), img };
