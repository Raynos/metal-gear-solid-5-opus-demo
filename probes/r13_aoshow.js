/**
 * r13_aoshow.js — the AO buffer, the depth it is derived from, and the normal it
 * reconstructs, written straight to the canvas so they can be photographed.
 *
 * `readRenderTargetPixels` on aoRT returns all zeros here, so the buffers are
 * shown by blitting instead. Returns data URLs; `probes/r13_dump.mjs` writes
 * them out.
 */
const g = window.__GAME;
const THREE = g.THREE;
const eng = g.engine ?? g.world.engine;
const pipe = eng.pipeline;
const r = eng.renderer;
const canvas = r.domElement;

g.applyShot('ground');
if (window.__pinDeterminism) window.__pinDeterminism();
g.settle(24);
eng.deterministic = true;
eng.stop();
for (let i = 0; i < 8; i++) eng.render();

const au = pipe.aoMat.uniforms;
const show = new THREE.ShaderMaterial({
  uniforms: {
    tAO: { value: pipe.aoRT.texture },
    tDepth: au.tDepth,
    uProjInv: au.uProjInv,
    uResolution: au.uResolution,
    uMode: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tAO, tDepth;
    uniform mat4 uProjInv;
    uniform vec2 uResolution;
    uniform int uMode;
    vec3 viewFromDepth(vec2 uv, float d) {
      vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 v = uProjInv * c;
      return v.xyz / v.w;
    }
    vec3 viewAt(vec2 uv) { return viewFromDepth(uv, texture2D(tDepth, uv).x); }
    void main() {
      vec4 ao = texture2D(tAO, vUv);
      float d = texture2D(tDepth, vUv).x;
      vec3 c;
      if (uMode == 0) c = vec3(ao.r);                       // broad visibility
      else if (uMode == 1) c = vec3(ao.g);                  // micro visibility
      else if (uMode == 2) c = vec3(pow(d, 220.0));         // depth, stretched
      else {
        vec2 t = 1.0 / uResolution;
        vec3 P = viewFromDepth(vUv, d);
        vec3 pxr = viewAt(vUv + vec2(t.x, 0.0)), pxl = viewAt(vUv - vec2(t.x, 0.0));
        vec3 pyu = viewAt(vUv + vec2(0.0, t.y)), pyd = viewAt(vUv - vec2(0.0, t.y));
        vec3 dx = abs(pxr.z - P.z) < abs(P.z - pxl.z) ? (pxr - P) : (P - pxl);
        vec3 dy = abs(pyu.z - P.z) < abs(P.z - pyd.z) ? (pyu - P) : (P - pyd);
        vec3 raw = normalize(cross(dx, dy));
        vec3 N = raw.z < 0.0 ? -raw : raw;
        if (uMode == 3) c = N * 0.5 + 0.5;                     // as shipped
        else if (uMode == 4) c = raw * 0.5 + 0.5;              // before the z-flip
        // Where the flip fires, and how close raw.z is to zero. Red = flipped.
        else if (uMode == 5) c = vec3(raw.z < 0.0 ? 1.0 : 0.0, raw.z > 0.0 ? 1.0 : 0.0, 0.0);
        else c = vec3(clamp(abs(raw.z) * 40.0, 0.0, 1.0));     // |N.z|, x40
      }
      gl_FragColor = vec4(c, 1.0);
    }
  `,
  depthTest: false, depthWrite: false,
});

const out = {};
for (const [name, mode] of [['ao_broad', 0], ['ao_micro', 1], ['depth', 2], ['normal', 3],
                            ['normal_raw', 4], ['flipmask', 5], ['nz_mag', 6]]) {
  show.uniforms.uMode.value = mode;
  pipe._blit(show, null);
  out[name] = canvas.toDataURL('image/png');
}
r.setRenderTarget(null);
return out;
