g.setFreeFly(false);
const pipeline = g.engine.pipeline;
const pass = g.world.registry.volumetrics.pass;
g.applyShot('vista'); g.settle(8);
const u = pass.volMat.uniforms;
const before = { hazeOwned: u.uHazeOwned.value, ownsHaze: pass.ownsHaze,
  aerialFlag: pipeline.enabled.aerial, apGain: u.uApGain.value, betaD: u.uBetaD.value.toArray(),
  dustH: u.uDustHeight.value };
pass.params.apGain = 0; g.settle(8);
const after = { apGainUniform: u.uApGain.value, paramsApGain: pass.params.apGain };
pass.params.apGain = 0.97; g.settle(4);
return { before, after, grade: { exposureKey: pipeline.grade.exposureKey, refRad: pipeline.grade.exposureRefRadiance, autoStops: pipeline.grade.autoExposureStops }, expInfo: pipeline.exposureInfo };
