const g = window.__GAME;
const W = g.world;
const pipe = g.engine.pipeline;
const snap = () => ({ mode: W.gameState.mode, ...pipe.enabled });
const t = [];
t.push(['boot', snap()]);
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F13', key: 'F13', bubbles: true }));
t.push(['after F13 keydown (settings arm)', snap()]);
g.applyShot('gameplay');
t.push(['after applyShot', snap()]);
g.settle(8);
t.push(['after settle', snap()]);
const autom = g.setAutomation(true);
const ret = W.gameState.setMode('play');
t.push([`after setMode('play') -> ${ret}`, snap()]);
g.settle(24);
t.push(['after settle(24)', snap()]);
const gp = W.registry?.gameplay;
return {
  trace: t,
  automation: autom,
  gameplayActive: gp?.active,
  cam: [g.engine.camera.position.x, g.engine.camera.position.y, g.engine.camera.position.z].map((v) => +v.toFixed(2)),
  fov: g.engine.camera.fov,
  localStorage: (() => { try { return localStorage.getItem('tpp.ui.settings'); } catch { return 'blocked'; } })(),
  errors: g.errors,
};
