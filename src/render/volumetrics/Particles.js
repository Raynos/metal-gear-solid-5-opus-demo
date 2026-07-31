import * as THREE from 'three';
import { buildSpriteAtlas } from './noise.js';

/**
 * ParticleAtmosphere — the two particulate layers that put the desert air on
 * screen at ground level:
 *
 *   dust    a wrapping field of motes around the camera, glued to the terrain
 *           by a vertex-shader height-field fetch and animated entirely on the
 *           GPU (zero CPU per frame), lit by the sun through the real shadow
 *           map so they go dark in shade.
 *   sand    wind-driven plumes streaming off ridge crests — the signature
 *           MGSV wide-shot detail. Emitters are picked once from the terrain's
 *           ridge curvature; the life cycle runs in the vertex shader.
 *
 * Both are MeshStandardMaterial + onBeforeCompile so they inherit shadows, IBL
 * and the scene fog, and both soft-fade against the linearised scene depth the
 * VolumetricPass publishes, so they never show a hard intersection edge.
 */

const PARTICLE_COMMON = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  attribute float aPhase;
  varying vec2 vQuadUv;
  varying float vAlpha;
  varying float vViewDepth;
  varying float vPhaseGain;
  uniform vec3 uCamPos;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  uniform vec3 uSunDirW;
  uniform float uPTime;
  uniform vec3 uWind;
  uniform sampler2D tHeight;
  uniform float uTerrainSize;
  uniform float uHMin;
  uniform float uHRange;
  uniform vec2 uHRes;
  uniform float uCell;
  uniform float uAmount;

  float decodeH(vec2 uvh) {
    vec4 t = textureLod(tHeight, uvh, 0.0);
    return uHMin + (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0 * uHRange;
  }
  // Manual bilinear: the height field is stored NEAREST (see TerrainFields).
  float terrainH(vec2 xz) {
    vec2 uvh = clamp(xz / uTerrainSize + 0.5, 0.0, 1.0) * uHRes - 0.5;
    vec2 b = floor(uvh);
    vec2 f = uvh - b;
    vec2 t = 1.0 / uHRes;
    vec2 u0 = (b + 0.5) * t;
    float h00 = decodeH(u0);
    float h10 = decodeH(u0 + vec2(t.x, 0.0));
    float h01 = decodeH(u0 + vec2(0.0, t.y));
    float h11 = decodeH(u0 + t);
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }
  float phg(float c, float g) {
    float g2 = g * g;
    float d = max(1e-4, 1.0 + g2 - 2.0 * g * c);
    return (1.0 - g2) / (12.5663706 * d * sqrt(d));
  }
`;

const PARTICLE_FRAG_COMMON = /* glsl */ `
  varying vec2 vQuadUv;
  varying float vAlpha;
  varying float vViewDepth;
  varying float vPhaseGain;
  uniform sampler2D tSceneDepth;
  uniform sampler2D tSprite;
  uniform vec2 uInvRes;
  uniform float uSoftness;
  uniform float uPTimeF;
`;

function makeParticleMaterial({ key, color, roughness, vertexBody, fragmentBody, uniforms }) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.0,
  });
  mat.userData.uniforms = uniforms;
  // Both particle materials are built by this one factory, so their
  // onBeforeCompile closures stringify identically — three's default program
  // cache key. Without an explicit key the second material silently reuses the
  // first one's compiled program and renders with the wrong vertex body.
  mat.customProgramCacheKey = () => key;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARTICLE_COMMON}`)
      // The billboard basis and the animated centre must exist before the
      // normal chunk, so the whole particle is resolved here.
      .replace('#include <beginnormal_vertex>', vertexBody)
      .replace('#include <begin_vertex>', 'vec3 transformed = gLocal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vViewDepth = -mvPosition.z;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARTICLE_FRAG_COMMON}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${fragmentBody}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           // Sphere-impostor normal. The quad is screen-aligned, so the impostor
           // frame IS view space and no basis change is needed. Gives every mote
           // a rounded, sun-facing terminator instead of a flat card.
           vec2 pc = vQuadUv * 2.0 - 1.0;
           float r2 = min(dot(pc, pc), 0.96);
           normal = normalize(vec3(pc * 0.85, sqrt(1.0 - r2)));
           nonPerturbedNormal = normal;
         }`,
      );
    mat.userData.shader = shader;
  };
  return mat;
}

const DUST_VERTEX = /* glsl */ `
  vec3 gLocal;
  vec3 objectNormal;
  {
    vec3 anchor = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    // Infinite field: the cell of anchors is tiled and re-centred on the camera
    // every frame, so motes exist everywhere the player can stand.
    vec2 drift = uWind.xz * uPTime * (0.35 + aSeed * 0.9);
    vec2 rel = mod(anchor.xz + drift - uCamPos.xz + uCell * 0.5, uCell) - uCell * 0.5;
    vec2 wxz = uCamPos.xz + rel;
    float g = terrainH(wxz);
    float bob = sin(uPTime * (0.5 + aSeed) + aPhase * 6.283) * 0.35 * anchor.y;
    vec3 center = vec3(wxz.x, g + anchor.y + bob, wxz.y);

    vec3 toCam = uCamPos - center;
    float cd = length(toCam);
    toCam /= max(cd, 1e-4);

    float s = aSize;
    float rot = aPhase * 6.283 + uPTime * 0.12 * (aSeed - 0.5);
    float cr = cos(rot), sr = sin(rot);
    vec2 c2 = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr) * s;
    vec3 corner = uCamRight * c2.x + uCamUp * c2.y;

    gLocal = (center - anchor) + corner;
    objectNormal = toCam;

    // Fade at the wrap boundary, and again very close to the lens so motes
    // never become full-screen smears.
    float rad = length(rel);
    float a = smoothstep(uCell * 0.5, uCell * 0.32, rad) * smoothstep(0.35, 2.2, cd);
    vAlpha = a * uAmount;
    vQuadUv = uv;
    vPhaseGain = phg(dot(normalize(center - uCamPos), uSunDirW), 0.62) * 12.566;
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  {
    vec2 pc = vQuadUv * 2.0 - 1.0;
    float r = dot(pc, pc);
    float soft = smoothstep(1.0, 0.05, r);
    float sceneZ = texture2D(tSceneDepth, gl_FragCoord.xy * uInvRes).r;
    // Soft depth fade: dissolve as the sprite approaches whatever is behind it.
    float fade = clamp((sceneZ - vViewDepth) / uSoftness, 0.0, 1.0);
    // ...and a second fade against the SKY. A mote seen against ground is lit by
    // roughly the same light as the ground and disappears into it; the same mote
    // seen against a 10x brighter sky is a dark speck, and a swarm of dark
    // specks over the horizon is one of the loudest particle-system tells there
    // is. Real suspended dust is only visible against the sky as a haze, never
    // as resolvable grains.
    float againstSky = smoothstep(2000.0, 6000.0, sceneZ);
    fade *= 1.0 - 0.86 * againstSky;
    diffuseColor.a *= soft * vAlpha * fade;
    if (diffuseColor.a < 0.002) discard;
    // Forward scattering: dust between the viewer and the sun blazes. The floor
    // has to stay high: a mote in open daylight is lit by the whole sky, not
    // just the sun, and at 0.35 the away-from-sun motes came out *darker* than
    // the sky behind them — a swarm of black flies across every wide shot.
    diffuseColor.rgb *= 0.85 + 1.35 * min(vPhaseGain, 10.0);
  }
`;

const SAND_VERTEX = /* glsl */ `
  vec3 gLocal;
  vec3 objectNormal;
  {
    vec3 anchor = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    float life = fract(aPhase + uPTime * (0.022 + aSeed * 0.016));
    vec3 wdir = normalize(vec3(uWind.x, 0.0, uWind.z));
    float travel = life * (180.0 + aSeed * 240.0);
    // sand lifts off the crest, then settles as it loses the ridge's updraught.
    // The lift matters more than the drift: a plume only reads if it clears the
    // ridge line and is seen against the sky.
    float rise = travel * 0.42 * (1.0 - life * 0.45) + 3.0;
    vec3 center = anchor + wdir * travel + vec3(0.0, rise, 0.0);
    center.x += sin(life * 7.0 + aPhase * 20.0) * 12.0 * aSeed;

    vec3 toCam = uCamPos - center;
    float cd = length(toCam);
    toCam /= max(cd, 1e-4);

    // Velocity-aligned ribbon: stretched along the wind, widened towards the
    // camera. Degenerate when looking straight down the wind, so fade there.
    vec3 side = cross(wdir, toCam);
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : uCamUp;
    float grow = 0.30 + life * 2.3;
    float s = aSize * grow;
    vec3 corner = wdir * (position.x * s * 1.7) + side * (position.y * s);

    gLocal = (center - anchor) + corner;
    objectNormal = toCam;

    float env = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.45, 1.0, life));
    // Ridge plumes are a wide-shot silhouette detail. Up close they are a
    // 40 m sheet across the lens, so fade them out inside 220 m entirely.
    float range = smoothstep(110.0, 300.0, cd) * (1.0 - smoothstep(2700.0, 4300.0, cd));
    vAlpha = env * uAmount * smoothstep(0.05, 0.4, sl) * range;
    vQuadUv = uv;
    vPhaseGain = phg(dot(normalize(center - uCamPos), uSunDirW), 0.55) * 12.566;
  }
`;

const SAND_FRAGMENT = /* glsl */ `
  {
    vec2 pc = vQuadUv * 2.0 - 1.0;
    float band = smoothstep(1.0, 0.0, abs(pc.y)) * smoothstep(1.0, 0.35, abs(pc.x));
    vec2 nuv = vQuadUv * vec2(1.3, 0.8) + vec2(-uPTimeF * 0.28, 0.0);
    float wisp = texture2D(tSprite, nuv).g * 0.62 + texture2D(tSprite, nuv * 2.3).b * 0.38;
    float sceneZ = texture2D(tSceneDepth, gl_FragCoord.xy * uInvRes).r;
    float fade = clamp((sceneZ - vViewDepth) / uSoftness, 0.0, 1.0);
    float a = band * smoothstep(0.16, 0.86, wisp) * vAlpha * fade * 0.45;
    diffuseColor.a *= a;
    if (diffuseColor.a < 0.002) discard;
    diffuseColor.rgb *= 0.95 + 0.9 * min(vPhaseGain, 5.0);
  }
`;

export class ParticleAtmosphere {
  constructor(world, fields, pass) {
    this.world = world;
    this.fields = fields;
    this.pass = pass;
    this.order = 420;

    this.sprite = buildSpriteAtlas(64);
    this.wind = new THREE.Vector3(0.86, 0, -0.51);
    this.cell = 90;

    this.shared = {
      uCamPos: { value: new THREE.Vector3() },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
      uPTime: { value: 0 },
      uPTimeF: { value: 0 },
      uWind: { value: this.wind },
      tHeight: { value: fields.heightTex },
      tSprite: { value: this.sprite },
      uTerrainSize: { value: fields.size },
      uHMin: { value: fields.hMin },
      uHRange: { value: fields.hRange },
      uHRes: { value: new THREE.Vector2(fields.res, fields.res) },
      uCell: { value: this.cell },
      tSceneDepth: { value: null },
      uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    };

    this._buildDust();
    this._buildSand();
  }

  _buildDust() {
    const N = 2600;
    const geo = new THREE.PlaneGeometry(1, 1);
    const u = {
      ...this.shared,
      uAmount: { value: 1.0 },
      uSoftness: { value: 1.6 },
    };
    this.dustUniforms = u;
    const mat = makeParticleMaterial({
      key: 'vol-dust',
      color: new THREE.Color(0.72, 0.66, 0.55),
      roughness: 1.0,
      vertexBody: DUST_VERTEX,
      fragmentBody: DUST_FRAGMENT,
      uniforms: u,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 4000;
    mesh.name = 'volumetric-dust';

    const m = new THREE.Matrix4();
    const seed = new Float32Array(N);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    let s = 1337;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < N; i++) {
      // y of the instance translation doubles as "height above the ground"
      const t = rnd();
      // Keep the band low. Motes lofted 16 m clear the horizon at eye level and
      // are then read as objects against the sky rather than as suspended dust.
      const h = 0.10 + Math.pow(t, 2.6) * 7.5;
      m.makeTranslation(rnd() * this.cell, h, rnd() * this.cell);
      mesh.setMatrixAt(i, m);
      seed[i] = rnd();
      // power-law sizes: mostly fine grit, a handful of soft dust bodies
      size[i] = 0.05 + Math.pow(rnd(), 2.4) * 0.40;
      phase[i] = rnd();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    mesh.instanceMatrix.needsUpdate = true;

    this.dust = mesh;
    this.world.scene.add(mesh);
  }

  /** Pick ridge crests: high, locally convex, exposed to the wind. */
  _findCrests(count) {
    const f = this.fields;
    const res = f.res;
    const H = f.heights;
    const step = f.size / (res - 1);
    const cands = [];
    const r = 6;
    for (let j = r + 1; j < res - r - 1; j += 2) {
      for (let i = r + 1; i < res - r - 1; i += 2) {
        const h = H[j * res + i];
        if (h < f.minH + (f.maxH - f.minH) * 0.52) continue;
        const lap =
          4 * h - H[j * res + i - r] - H[j * res + i + r] - H[(j - r) * res + i] - H[(j + r) * res + i];
        if (lap <= 0) continue;
        cands.push({ i, j, h, w: lap * (0.4 + (h - f.minH) / (f.maxH - f.minH)) });
      }
    }
    cands.sort((a, b) => b.w - a.w);
    const picked = [];
    const minSep = 46 / step;
    for (const c of cands) {
      if (picked.length >= count) break;
      let ok = true;
      for (const p of picked) {
        const dx = p.i - c.i;
        const dj = p.j - c.j;
        if (dx * dx + dj * dj < minSep * minSep) {
          ok = false;
          break;
        }
      }
      if (ok) picked.push(c);
    }
    const half = f.size * 0.5;
    return picked.map((p) => ({
      x: -half + p.i * step,
      z: -half + p.j * step,
      y: p.h,
    }));
  }

  _buildSand() {
    const emitters = this._findCrests(190);
    const perEmitter = 7;
    const N = Math.max(1, emitters.length * perEmitter);
    const geo = new THREE.PlaneGeometry(1, 1);
    const u = {
      ...this.shared,
      uAmount: { value: 1.0 },
      uSoftness: { value: 22.0 },
    };
    this.sandUniforms = u;
    const mat = makeParticleMaterial({
      key: 'vol-sand',
      color: new THREE.Color(0.66, 0.58, 0.46),
      roughness: 1.0,
      vertexBody: SAND_VERTEX,
      fragmentBody: SAND_FRAGMENT,
      uniforms: u,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 4010;
    mesh.name = 'volumetric-ridge-sand';

    const m = new THREE.Matrix4();
    const seed = new Float32Array(N);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    let s = 99173;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let k = 0; k < N; k++) {
      const e = emitters[k % emitters.length] ?? { x: 0, y: 0, z: 0 };
      m.makeTranslation(e.x + (rnd() - 0.5) * 30, e.y + 1.0 + rnd() * 4.0, e.z + (rnd() - 0.5) * 30);
      mesh.setMatrixAt(k, m);
      seed[k] = rnd();
      size[k] = 9.0 + rnd() * 20.0;
      phase[k] = rnd();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    mesh.instanceMatrix.needsUpdate = true;

    this.sand = mesh;
    this.world.scene.add(mesh);
  }

  update(dt, engine) {
    const cam = engine.camera;
    const s = this.shared;
    s.uCamPos.value.copy(cam.position);
    s.uCamRight.value.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    s.uCamUp.value.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    s.uSunDirW.value.copy(this.world.lighting.sunDirection);
    s.uPTime.value = engine.elapsed;
    s.uPTimeF.value = engine.elapsed;
    const pass = this.pass;
    if (pass?.depthRT) {
      s.tSceneDepth.value = pass.depthRT.texture;
      s.uInvRes.value.set(1 / pass._width, 1 / pass._height);
    }
    // Dust rides the same time-of-day tuning as the haze. At night there is no
    // thermal turbulence lofting it and nothing to light it, so it all but
    // vanishes rather than sitting there as a grey fog of dots.
    const amt = pass?.params?.dustBand ?? 1.0;
    const day = 1.0 - 0.88 * (this.world.lighting.night ?? 0);
    this.dustUniforms.uAmount.value = 0.5 * amt * day;
    this.sandUniforms.uAmount.value = (0.26 + 0.16 * amt) * day;
  }

  dispose() {
    this.world.scene.remove(this.dust, this.sand);
    this.dust.geometry.dispose();
    this.sand.geometry.dispose();
    this.sprite.dispose();
  }
}
