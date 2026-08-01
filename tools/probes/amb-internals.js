const L = g.world.lighting;
const out = {};
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
for (const tod of ['noon', 'afternoon', 'dusk', 'dawn', 'night']) {
  L.setTimeOfDay(tod);
  const a = L.ambient;
  const nrm = (c) => c.map((v) => +(v / Math.max(c[1], 1e-9)).toFixed(3));
  out[tod] = {
    keyColor: L.keyColor, keyIntensity: +L.keyIntensity.toFixed(3),
    useApi: typeof L.sky.radianceInDirection === 'function',
    irradianceUp_norm: nrm(a.irradianceUp), irradianceUp_lum: +lum(a.irradianceUp).toFixed(4),
    hazeRadiance_norm: nrm(a.hazeRadiance), hazeRadiance_lum: +lum(a.hazeRadiance).toFixed(5),
    groundShade_norm: nrm(a.groundShadeRadiance),
    ratio: a.ratio, scale: +a.scale.toFixed(3),
    exposure: g.engine.pipeline.exposureInfo,
  };
}
return out;
