/**
 * r11_shadowtone.js — what a surface in shadow is actually lit BY.
 *
 * ARCHITECTURE.md's visual target says shadows must be "lifted, cool, and full
 * of bounced sky light — never crushed to black". The presented frames say the
 * opposite: shots/before/ground.png reads 51,46,40 on shaded sand (B/R 0.79
 * against 0.70 on lit sand — barely any hue swing at all) and 9,9,9 with a
 * minimum of 0 in the pocket under op-arch-canvas, which is NEUTRAL, i.e. the
 * grade's black pedestal with no sky in it whatever.
 *
 * This reports the terms that decide that, in linear units, so the argument is
 * about radiance and not about 8-bit pixels: the SH probe's irradiance for an
 * up-facing and a down-facing normal, its blue/red, the sky's own blue/red
 * before any pedestal, and what the AO buffer is handing the pocket.
 *
 * Runs over every time of day, because the night preset is the one frame this
 * project would put in a trailer and any change here has to be shown not to
 * move it.
 */
const g = window.__GAME;
const THREE = g.THREE;
const lighting = g.world.lighting;
const out = {};

const up = new THREE.Vector3(0, 1, 0);
const dn = new THREE.Vector3(0, -1, 0);
const side = new THREE.Vector3(1, 0, 0);

for (const tod of ['noon', 'afternoon', 'dusk', 'night']) {
  lighting.setTimeOfDay(tod);
  const a = lighting.ambient;
  const sh = lighting.probe.sh;
  const irr = (n) => {
    const c = new THREE.Vector3();
    sh.getIrradianceAt(n, c);
    return [c.x, c.y, c.z];
  };
  const br = (v) => +(v[2] / Math.max(v[0], 1e-9)).toFixed(3);
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const eUp = irr(up), eDn = irr(dn), eSide = irr(side);
  const key = a.keyIrradiance;
  out[tod] = {
    keyIrradiance: key.map((v) => +v.toFixed(3)),
    keyLum: +lum(key).toFixed(3),
    // Fill on a flat up-facing surface — the sand in a cast shadow.
    fillUp: eUp.map((v) => +v.toFixed(4)),
    fillUpLum: +lum(eUp).toFixed(4),
    fillUpBR: br(eUp),
    fillSideBR: br(eSide),
    fillDownBR: br(eDn),
    // Stops between lit sand and the same sand in shadow, before AO.
    keyOverFillStops: +Math.log2(Math.max(lum(key) + lum(eUp), 1e-9) / Math.max(lum(eUp), 1e-9)).toFixed(2),
    ratioTarget: +a.ratio.toFixed(2),
    calibScale: +a.scale.toFixed(3),
    // The sky BEFORE the warm pedestal and the skyline lift are folded in.
    hazeBR: br(a.hazeRadiance),
    ambientBR: +a.blueOverRed.toFixed(3),
    bounceIrradiance: a.bounceIrradiance.map((v) => +v.toFixed(4)),
    groundShadeRadiance: a.groundShadeRadiance.map((v) => +v.toFixed(4)),
  };
}

lighting.setTimeOfDay('noon');
out.model = {
  litNear: lighting.ambientModel.litNear,
  litSun: lighting.ambientModel.litSun,
  nearSkyBlock: lighting.ambientModel.nearSkyBlock,
  nearBand: lighting.ambientModel.nearBand,
  pedestalDown: lighting.ambientModel.pedestalDown,
  aoRadius: lighting.ambientModel.aoRadius,
};
return out;
