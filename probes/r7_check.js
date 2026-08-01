// Is my Terrain edit even in the page? Read the uniforms back and confirm the
// injected source is present in the compiled shader.
const t = g.world.terrain;
const u = t.uniforms;
const sh = t.material.userData.shader;
const src = sh ? sh.fragmentShader : '';
return {
  hasUDbg2: !!u.uDbg2,
  uDbg2: u.uDbg2 ? u.uDbg2.value.toArray() : null,
  rockLight: u.uRockLight.value.toArray(),
  gravelClast: u.uGravelClast ? u.uGravelClast.value.toArray() : null,
  varnish: u.uVarnish.value.toArray(),
  shaderHasPavement: src.includes('desert pavement, the MID field'),
  shaderHasROT_P: src.includes('ROT_P'),
  shaderLen: src.length,
  matUUID: t.material.uuid,
  programs: g.engine.renderer.info.programs.length,
};
