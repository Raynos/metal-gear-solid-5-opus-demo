/**
 * r9_post.js — do the blind posts get corrected, and is the HUD's detection
 * feed the shape it claims to be?
 */
const g = window.__GAME;
const THREE = g.THREE;
const W = g.world;
const eng = W.engine;
const ai = W.registry.ai;
if (!ai) return { error: 'no ai module' };

const grid = ai.navGrid;
const eye = new THREE.Vector3();
function openness(gd) {
  ai.eyeOf(gd.ch, eye);
  let open = 0;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const x = gd.ch.position.x - Math.sin(a) * 15;
    const z = gd.ch.position.z - Math.cos(a) * 15;
    if (grid.losClear(eye.x, eye.y, eye.z, x, grid.heightAt(x, z) + 1.3, z)) open++;
  }
  return Math.round((100 * open) / 24);
}

const out = {};
out.before = ai.guards.map((gd) => `${gd.role}${gd.blindPost ? '*' : ' '} ${openness(gd)}%`);
out.blindPosts = ai.guards.filter((gd) => gd.blindPost).length;

// Backdrop must not move anybody: that is what the shot harness depends on.
const snap = ai.guards.map((gd) => gd.ch.position.clone());
for (let i = 0; i < 60 * 10; i++) eng.step(1 / 60);
out.backdropDrift = +Math.max(...ai.guards.map((gd, i) => gd.ch.position.distanceTo(snap[i]))).toFixed(4);

// Live: the corrected men walk to a post that can see.
ai.setLive(true);
for (let i = 0; i < 60 * 45; i++) eng.step(1 / 60);
out.after = ai.guards.map((gd) => `${gd.role}${gd.blindPost ? '*' : ' '} ${openness(gd)}%`);
out.worstAfter = Math.min(...ai.guards.map(openness));

// The HUD feed.
const c = ai.contacts();
out.contactSample = c[0];
out.contactCount = c.length;
out.contactsAllocFree = ai.contacts() === c ? 'same array reused' : 'NEW ARRAY (bad)';
out.detection = ai.detection();
out.cost = { ema: ai.stats.ms, peak: ai.stats.msPeak };
ai.setLive(false);
out.errors = g.errors.length;
return out;
