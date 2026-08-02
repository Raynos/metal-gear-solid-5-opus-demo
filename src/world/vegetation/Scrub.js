import * as THREE from 'three';
import { GLSL_DRY_SHADING, GLSL_NOISE, GLSL_WIND } from './shaderLib.js';
import { mulberry32, smooth01 } from './VegField.js';
import { buildTuft } from './Grass.js';
import { brushParams, deadTreeParams, deadTreeParamsL1, growPlant, scrubParams } from './Branching.js';

/**
 * Scrub — the woody half of the vegetation: thorny shrubs, dry brush balls and
 * the occasional dead tree. These carry the silhouette work that grass cannot;
 * a bare tree against a ridgeline is the single most legible MGSV composition,
 * and low dead scrub dotted across a slope is what tells you the slope is a
 * slope rather than a shaded triangle.
 *
 * Round 1 put 656 bushes over a 380 m disc — one per 700 square metres, which
 * is optically nothing. This scatters ~31,000 over a 1 km disc in three tiers,
 * for about four times the triangles, because the distant tiers are ribbon
 * clumps at 10-24 triangles rather than branch skeletons at 416.
 *
 * Everything is instanced, buckets spatially so the frustum can discard the
 * four fifths of the field behind the camera, casts shadow only within a few
 * tens of metres, and sways on the same gust field as the grass so the whole
 * landscape moves as one system.
 */

/**
 * Woody albedo, linear.
 *
 * Round 2 ran these at 0.30-0.43, which is mineral territory — the same value
 * range as the sand, and a dead branch measured display luminance 80 in a NIGHT
 * frame. Round 3 took them to 0.117-0.166 and overshot just as far the other
 * way: those are the values that made the vista's mid-ground read as black
 * pepper on pale sand, 9,767 countable dots between 320 and 1050 m.
 *
 * Weathered dead wood is 0.16-0.22 linear, and a thorn bush is not bare wood —
 * it is wood plus a haze of dry leaf and thorn, which is paler still. These are
 * scrub 0.192, bush 0.176, brush 0.240 (bleached tumbleweed really is the
 * palest thing in the set) and tree 0.206, against sandDark 0.38 and sandLight
 * 0.55. Dry scrub is still unambiguously darker than sunlit sand — about 45% of
 * it — but it is now a mid-value warm khaki rather than a silhouette, and it is
 * warmer than the sand it stands in (R/B 1.6-1.8 against sand's 1.28) rather
 * than merely darker.
 *
 * ROUND 8 leaves the LUMINANCES essentially alone — the round-3 overshoot is a
 * real trap and these are in the right band — and spends the change on chroma,
 * R/B 1.6-1.8 -> 2.2-2.6. Measured on the reference, dry Afghan scrub is not a
 * neutral dark: mgi-1's foreground brush renders at lin 0.137/0.122/0.067 and
 * mgi-3's at 0.126/0.104/0.034, both R/B ~2.0-3.7 in the RENDERED frame, which
 * needs more than that in the albedo once a beam at R/B 1.26 has been divided
 * out. The one exception is `tree`, which drops 12% in luminance: a dead tree in
 * mgi-3 is a hard dark silhouette against the sky and ours was reading as a
 * mid-value twig.
 */
const BRANCH_COLORS = {
  scrub: [0.276, 0.198, 0.106],
  bush: [0.260, 0.184, 0.094],
  brush: [0.344, 0.250, 0.132],
  tree: [0.246, 0.186, 0.104],
};

/**
 * Wind flex per plant family, in object units at the branch tips.
 *
 * Round 3's numbers were 0.03-0.055, and they were not "restrained", they were
 * dead. The sway a vertex actually gets is `uWind.z * (0.22 + gust * 1.15) *
 * flex`, and with uWind.z = 0.22 and a typical gust of 0.5 that came out at
 * 0.175 * flex — under a centimetre of travel on a metre-tall bush. So the
 * critics' "coherent gusts crossing the field" only ever applied to the grass:
 * the woody half of the landscape stood perfectly still through every gust, and
 * a still bush next to moving grass is worse than neither moving.
 *
 * These give a tip excursion of 4-6% of plant height at mean gust and 9-11% at
 * the front of one. Stiffness is by family and it is real: a dead tree's trunk
 * does not move and only the outer twigs whip (and aVeg.x^2 already puts the
 * motion there), a thorn bush is rigid, and a dry brush ball is nearly weightless.
 */
const SWAY = { scrub: 0.20, bush: 0.30, brush: 0.26, tree: 0.13 };

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qIdentity = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _scale = new THREE.Vector3();

/**
 * Per-vertex work shared by every woody material: the distance LOD and the wind.
 *
 * LOD. Round 3's woody field was submitted at full size all the way out — bushes
 * to 1050 m, dead trees to 760 m — and all three critics read the result as
 * countable specks rather than as ground cover. A bush at 700 m is two pixels
 * across, and two pixels of anything whose value does not match the terrain
 * behind it is a dot, not a plant. So each tier fades over a band and stops:
 * thinned stochastically by a stable per-instance hash *and* shrunk, because
 * thinning alone leaves full-size plants right up to the cut and shrinking alone
 * leaves a field of ever-smaller specks — which is the confetti in another form.
 * What carries the coverage past the cut is the tonal layer in Grass.js, which
 * paints it into the ground instead of standing it up in front of the ground.
 *
 * Wind. Same gust field as the grass, but the bend is computed in world space
 * and rotated back into object space through the instance matrix, so a rotated
 * bush still leans downwind. `uFlex` is per material; the scale is per vertex
 * (aVeg.x, 0 at the root and 1 at the tips) so a trunk barely moves while the
 * outer twigs whip.
 */
// A tier with no LOD band still has to give smoothstep two DIFFERENT edges —
// smoothstep(a, a, x) is a division by zero and the whole plant becomes NaN.
const NO_LOD = [1e7, 2e7];

/**
 * Where the woody field fades out and stops, in metres from the camera.
 *
 * Same numbers as `GRASS_FADE_START` / `GRASS_MAX_DIST` in Grass.js, and
 * deliberately so: a landscape whose grass merges into the ground at 140 m while
 * its bushes stay countable to 560 m has two different LOD philosophies visible
 * in one frame. Past this the coverage is the cover layer's job — it paints the
 * stand into the ground plane instead of standing it up in front of it.
 */
const BUSH_LOD = [60, 140];

function injectBranchWind(mat, uniforms, flexAmount, lod = NO_LOD) {
  const local = {
    uFlex: { value: flexAmount },
    uVegLod: { value: new THREE.Vector2(lod[0], lod[1]) },
  };
  mat.userData.uniforms = local;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, local);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aVeg;   // (flex along branch, per-branch phase, unused)
         uniform float uFlex;
         uniform vec2 uVegLod;  // (fade start, hard cut) in metres
         ${GLSL_NOISE}
         ${GLSL_WIND}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           #ifdef USE_INSTANCING
             mat4 vegInst = instanceMatrix;
           #else
             mat4 vegInst = mat4(1.0);
           #endif
           vec3 vegOrigin = (modelMatrix * vegInst * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

           // ---- distance LOD ----
           float vegD = length(vegOrigin.xz - cameraPosition.xz);
           float lodK = 1.0 - smoothstep(uVegLod.x, uVegLod.y, vegD);
           // Hash the instance's own world position, so which plants survive the
           // thinning is a property of the ground and not of the camera: walk
           // toward the field and the survivors stay put instead of reshuffling.
           float lodPick = vegHash21(floor(vegOrigin.xz * 3.17));
           float lodS = lodPick < lodK ? (0.40 + 0.60 * lodK) : 0.0;
           // Scaled about the instance origin, which for every plant here is the
           // root, so a fading bush sinks into the ground rather than shrinking
           // toward its own middle and hovering.
           transformed *= lodS;

           float gust = vegGust(vegOrigin.xz);
           vec3 wWorld = vec3(uWind.x, 0.0, uWind.y);
           mat3 im = mat3(modelMatrix * vegInst);
           // (M^T * w) — puts the world wind vector into object space without
           // needing an inverse; column dots are exactly the transpose product.
           vec3 wObj = vec3(dot(im[0], wWorld), dot(im[1], wWorld), dot(im[2], wWorld));
           float wl = length(wObj);
           if (wl > 1e-5 && lodS > 0.0) {
             wObj /= wl;
             float flex = aVeg.x * aVeg.x * uFlex;
             float sway = uWind.z * (0.22 + gust * 1.15) * flex;
             float rustle = sin(uTime * 5.7 + aVeg.y * 6.283 + gust * 7.0) * 0.10 * flex * (0.3 + gust);
             transformed += wObj * (sway + rustle) * lodS;
             transformed.y -= sway * sway * 0.9 * lodS;
           }
         }`,
      );
    mat.userData.shader = shader;
  };
}

/**
 * Dead wood under a hard sun has the same problem grass does: a twig is a
 * cylinder two centimetres across, so half of it is blown out and half is a
 * black line. The same translucency + wrapped-sky term the grass uses lifts the
 * shadow side, at a fraction of the strength — bark transmits, but not much.
 */
function injectBranchShading(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    prev.call(mat, shader);
    // The stock `normal` varying is in view space; the sun direction is in world
    // space. Carry a world-space normal and position of our own rather than
    // transforming the sun per fragment.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVegWorld;\nvarying vec3 vVegNW;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         {
           #ifdef USE_INSTANCING
             mat4 vegM = modelMatrix * instanceMatrix;
           #else
             mat4 vegM = modelMatrix;
           #endif
           vVegWorld = (vegM * vec4(transformed, 1.0)).xyz;
           vVegNW = normalize(mat3(vegM) * objectNormal);
         }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vVegWorld;\nvarying vec3 vVegNW;\n${GLSL_DRY_SHADING}`)
      // The bush tiers are double-sided ribbon domes carrying an outward DOME
      // normal, and three flips that normal on back faces — pointing it into the
      // bush, away from every light in the scene. Half of every clump therefore
      // rendered unlit, which is most of what made the far field read as pepper.
      // A dome normal is the right shading normal for a mass of twigs whichever
      // face of it you happen to be looking at.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         #ifdef DOUBLE_SIDED
           normal *= faceDirection;
           nonPerturbedNormal = normal;
         #endif`,
      )
      .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>')
      .replace('#include <lights_fragment_begin>', '#include <lights_fragment_begin>\nfloat vegSunVis = getShadowMask();')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         // A fifth of the grass gain: bark is a millimetre of dead cellulose,
         // not a membrane. Enough to keep the shadow side off black, not enough
         // to make a dead bush glow like a lampshade.
         {
           vec3 vegToCam = cameraPosition - vVegWorld;
           float vegDist = length(vegToCam);
           reflectedLight.directDiffuse +=
             vegDryShading(normalize(vVegNW), vegToCam / max(vegDist, 1e-4), diffuseColor.rgb, 0.30, vegSunVis, vegDist);
           // See VEG_BOUNCE. The IBL is a sky projection and nothing else, so
           // without this the interior of every bush is lit by blue light only.
           reflectedLight.indirectDiffuse *= vegBounceTint(normalize(vVegNW));
         }`,
      );
    mat.userData.shader = shader;
  };
}

function branchMaterial(uniforms, color, flex, roughness = 0.88, lod) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace),
    roughness,
    metalness: 0.0,
    // A twig inside a thorn bush sees a fraction of the sky; the bush shadows
    // itself. 0.9 was close enough to open-sky that a dead bush held its own
    // against sunlit sand at night, which is how the critics caught it.
    // Round 4: 0.62 -> 0.95. A bush on open ground is a sparse structure, not a
    // solid: most of its twigs are on the outside of it and see a good deal more
    // than three fifths of the sky. 0.62 was the second of three places round 3
    // subtracted for self-occlusion, and together they made the far field read
    // as pepper. It matters most where there is no sun at all: on the dusk
    // frame's shaded foreground slope the ambient IS the entire light budget, so
    // every count taken off it here came straight off the plant's only light.
    envMapIntensity: 0.95,
    dithering: true,
  });
  injectBranchWind(mat, uniforms, flex, lod);
  injectBranchShading(mat);
  return mat;
}

/** Depth material matching the wind AND the LOD, or shadows detach from the plant. */
function matchingDepthMaterial(uniforms, flex, lod) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  injectBranchWind(d, uniforms, flex, lod);
  return d;
}

/**
 * Sample candidate points uniformly *by area* over an annulus and keep the ones
 * the ground accepts. Uniform-by-area matters: sampling r linearly piles
 * everything into the middle and leaves the outer ring — which is most of the
 * frame in a wide shot — empty.
 */
function scatterAnnulus({ field, rng, rInner, rOuter, candidates, accept, variants, tilt, scaleRange, sink = 0 }) {
  const perVariant = variants.map(() => []);
  const r2i = rInner * rInner;
  const r2o = rOuter * rOuter;
  // Log-uniform over the scale range. Round 2 drew it linearly over a 2x span,
  // so nearly every instance came out within 30% of the mean and the field read
  // as one stamped size at one density — the critics' third finding. A log draw
  // over a 3x span spends as much of its budget on the runts as on the big ones,
  // and the runts are what make the big ones look big.
  const logRatio = Math.log(scaleRange[1] / scaleRange[0]);
  for (let i = 0; i < candidates; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(r2i + (r2o - r2i) * rng());
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const s = field.density(x, z);
    if (!accept(s, rng, x, z, r)) continue;
    const v = Math.floor(rng() * variants.length);
    const scale = scaleRange[0] * Math.exp(logRatio * rng());
    _q.setFromUnitVectors(_up, s.normal).slerp(_qIdentity, 1 - tilt);
    _q.multiply(_qYaw.setFromAxisAngle(_up, rng() * Math.PI * 2));
    _v.set(x, s.height - sink * scale, z);
    // Squashed on two independent horizontal axes and in height: a handful of
    // geometry variants all standing at the same proportions is still one shape.
    _scale.set(scale * (0.76 + rng() * 0.46), scale * (0.80 + rng() * 0.44), scale * (0.76 + rng() * 0.46));
    perVariant[v].push(_m.compose(_v, _q, _scale).clone());
  }
  return perVariant;
}

/**
 * One InstancedMesh has a single bounding sphere, so a world-spanning one is
 * never frustum-culled and is re-submitted for every shadow cascade. Splitting a
 * tier onto a coarse spatial grid costs a handful of draw calls and lets the
 * frustum discard most of the field — which is the only reason several thousand
 * distant bushes fit in the triangle budget at all.
 */
function buildTiles(geo, mats, mat, depthMat, name, tile, shadowRadius = 0) {
  // Shadow casting is bucketed with the geometry, not switched per tier: a bush
  // 150 m from the compound casts a shadow that is not one pixel of anything,
  // but it is still re-submitted once per cascade. Splitting at `shadowRadius`
  // costs one draw call and takes most of the field out of three depth passes.
  const r2 = shadowRadius * shadowRadius;
  const buckets = new Map();
  for (const m of mats) {
    const x = m.elements[12];
    const z = m.elements[14];
    const bx = Math.floor(x / tile);
    const bz = Math.floor(z / tile);
    const near = r2 > 0 && x * x + z * z <= r2;
    const key = (bx * 4096 + bz) * 2 + (near ? 1 : 0);
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(m);
  }

  // Merge back every tile whose bounding circle still contains the play centre.
  //
  // A tile is only worth its draw call if the frustum can throw it away, and a
  // bounding sphere that contains the eye is inside every frustum there is.
  // Measured on `gameplay` at 1920x1080, this module was submitting 67 meshes of
  // which the near tiers' 48 were all of that kind: the tile grid was 500 m
  // across a field 148 m in radius, so the split was a quadranting of the field
  // about the origin and every quadrant reached back to it. Forty-odd draw calls
  // that could never be culled and never were. The far tiers (dead trees out to
  // 740 m) do stand clear of the centre, and those keep their tiles.
  // Key well outside the (bx * 4096 + bz) range so it cannot collide with a tile.
  const CORE = 2000000;
  for (const [key, list] of [...buckets]) {
    if (key >= CORE) continue;
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
    for (const m of list) {
      const x = m.elements[12];
      const z = m.elements[14];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    // True enclosing radius, not the box diagonal: a quarter-annulus of plants
    // hugs its corner, and the box measure reads 12% small there — exactly the
    // margin this test turns on.
    let r = 0;
    for (const m of list) {
      const d = Math.hypot(m.elements[12] - cx, m.elements[14] - cz);
      if (d > r) r = d;
    }
    // A tile has to clear the play centre by a real margin to be worth a draw
    // call; grazing it means the camera is inside its sphere from anywhere in
    // the compound and the frustum can never reject it.
    if (Math.hypot(cx, cz) > r * 1.3) continue;
    const merged = CORE + (key & 1);
    const into = buckets.get(merged);
    if (into) into.push(...list);
    else buckets.set(merged, list);
    buckets.delete(key);
  }

  const meshes = [];
  let tris = 0;
  for (const [key, list] of buckets) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.computeBoundingSphere();
    const casts = (key & 1) === 1;
    mesh.castShadow = casts;
    mesh.receiveShadow = true;
    if (casts) mesh.customDepthMaterial = depthMat;
    mesh.name = `${name}-${key}`;
    meshes.push(mesh);
    tris += (geo.index.count / 3) * list.length;
  }
  return { meshes, tris };
}

/**
 * Three distance tiers of thorny scrub, plus brush balls and dead trees.
 * Geometry detail and shadow casting both fall off with range; instance density
 * does not, because a slope that is bare at 300 m and dotted at 80 m reads as a
 * bug.
 */
export function createScrub(field, uniforms, seed = 20260731) {
  const rng = mulberry32(seed);
  const meshes = [];
  let tris = 0;
  const counts = {};

  const add = (r) => {
    meshes.push(...r.meshes);
    tris += r.tris;
  };

  // ---- thorny scrub, near: full branch structure, casts shadow -------------
  // Scale tops out just under 1.6: this is *low* dead scrub, knee to waist. A
  // 2.5 m specimen reads as a dead sapling and steals the dead trees' job.
  const scrubGeos = [0, 1, 2, 3].map((i) => growPlant(scrubParams(4100 + i * 137)));
  const scrubMat = branchMaterial(uniforms, BRANCH_COLORS.scrub, SWAY.scrub, 0.92, [44, 64]);
  const scrubDepth = matchingDepthMaterial(uniforms, SWAY.scrub, [44, 64]);
  const near = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 62, candidates: 2000,
    // Scrub survives where grass is only patchy — the drier margins — and it is
    // the one thing that keeps growing on ground too steep for tussock.
    //
    // The constant floors in every one of these tests used to be the whole
    // problem: at `0.10 + density*1.05` a tenth of the candidates landed on
    // ground the mask had rejected outright, which put an even pepper over the
    // entire pan no matter what the density field said. Round 4 took the last of
    // that floor out of `woody` itself (see VegField.density), so these floors
    // are now genuinely strays.
    accept: (s, r) => r() < 0.004 + Math.pow(s.woody, 0.85) * 0.95,
    variants: scrubGeos, tilt: 0.5, scaleRange: [0.42, 1.72], sink: 0.05,
  });
  scrubGeos.forEach((g, i) => add(buildTiles(g, near[i], scrubMat, scrubDepth, `scrub-n${i}`, 500, 62)));
  counts.scrubNear = near.reduce((a, b) => a + b.length, 0);

  // ---- massed bush clumps -------------------------------------------------
  // ROUND 5, MAJOR 5. Round 4 ran three tiers: near (0-145 m, no fade at all),
  // mid (118-345 m) and far (315-560 m). Measured by ablation on the shipped
  // vista with the auto-exposure locked, the two distant tiers delivered
  //   bush-m  6,414 instances -> 6,422 changed pixels = 1.0 px per bush
  //   bush-f  4,579 instances -> 8,435 changed pixels = 1.8 px per bush
  // That is the definition of countable specks: eleven thousand objects each
  // covering one to two pixels, lit as a vertical translucent membrane in front
  // of horizontal mineral ground. No amount of albedo tuning fixes a one-pixel
  // object; the honest LOD for a thing smaller than a pixel is to darken the
  // pixel instead, which is what createCoverMat does. Both tiers are gone, the
  // 123k triangles they cost are what pays for the rocks' talus aprons, and the
  // near tier now FADES over 60-140 m instead of ending on a hard circle.
  const bushMatNear = branchMaterial(uniforms, BRANCH_COLORS.bush, SWAY.bush, 0.94, BUSH_LOD);
  bushMatNear.side = THREE.DoubleSide;
  const bushDepth = matchingDepthMaterial(uniforms, SWAY.bush, BUSH_LOD);
  bushDepth.side = THREE.DoubleSide;

  // ROUND 11. This tier was the single loudest object in the `ground` frame and
  // it had been mis-filed. The round-11 brief described "flat plates heaped near
  // the sandbags" and attributed them to rocks/Scatter.js `rock_chips`; shooting
  // the same frame with `--hide rock_chips` leaves them untouched, `--hide clast`
  // leaves them untouched, and `--hide bush` removes them completely. They are
  // THIS, and they are not stone at all — they are a fan of 1.5 m planks stuck
  // in the sand in front of the sandbag wall, which is what a bush made of nine
  // ribbons becomes when you let it grow to nearly 3x.
  //
  // Do the arithmetic that nobody did when the tier was authored. A blade is
  // `width` wide and `maxH` long IN THE GEOMETRY, and `scatterAnnulus` then
  // applies `scaleRange` AND a further per-axis squash of up to 1.22-1.24. At
  // the top of the old range that is 0.085 * 2.40 * 1.22 = 0.25 m wide and
  // 0.66 * 2.40 * 1.24 = 1.96 m long: a quarter-metre plank two metres tall,
  // straight (two segments cannot curve), double-sided, and shaded off a dome
  // normal so it holds one flat value across its whole width. Nine of them
  // radiating from a point is a fan of broken boards, and it is worse in the
  // near frames than anything the clast field was doing.
  //
  // The fix is to make a bush out of twigs rather than out of boards — three
  // times as many blades, a THIRD of the width, a segment more so the arc is an
  // arc — and to stop it growing into the dead trees' job. 1.30 caps it at a
  // ~1.0 m specimen, which is what "low massed clump" was supposed to mean.
  // Cost: 36 -> 72 triangles an instance on this tier alone.
  //
  // Capping the scale is a COVER cost and it has to be paid back, or this is
  // just deleting clutter. Measured by ID pass (probes/r11_cover.js — flat
  // emissive magenta, counted per shot; the obvious `--hide` difference cannot
  // do it, because a stone brought within a stop of the sand stops registering
  // as changed and the fix reads as a loss), capping alone took the woody
  // scatter from 0.545% to 0.256% of the outpost frame and 0.464% to 0.228% of
  // the ground frame — a bit over half. So the cap is paid for with count and a
  // slightly higher ceiling: 1.30 -> 1.58 and the acceptance 0.60 -> 0.76, which
  // is 1.5x the footprint per body and 1.25x the bodies. It buys the cover back
  // out of small specimens rather than out of two-metre boards, which is what
  // TODO.md 1.6 is asking for: the ground has no 1-10 cm structure, and one
  // large object is not a substitute for many small ones.
  const bushGeoNear = [0, 1].map((i) => buildTuft({
    blades: 12, segments: 3, seed: 8810 + i * 57,
    minH: 0.34, maxH: 0.66, width: 0.030, spread: 0.15, curve: 1.35, dome: 0.7,
  }));
  const bushNear = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 148, candidates: 19000,
    accept: (s, r) => r() < 0.0012 + Math.pow(s.woody, 0.85) * 0.76,
    variants: bushGeoNear, tilt: 0.55, scaleRange: [0.50, 1.58], sink: 0.05,
  });
  bushGeoNear.forEach((g, i) => add(buildTiles(g, bushNear[i], bushMatNear, bushDepth, `bush-n${i}`, 500, 48)));
  counts.bushNear = bushNear.reduce((a, b) => a + b.length, 0);

  // ---- dry brush balls ----------------------------------------------------
  const brushGeos = [0, 1, 2].map((i) => growPlant(brushParams(7700 + i * 91)));
  const brushMat = branchMaterial(uniforms, BRANCH_COLORS.brush, SWAY.brush, 0.95, BUSH_LOD);
  const brushDepth = matchingDepthMaterial(uniforms, SWAY.brush, BUSH_LOD);
  const brush = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 148, candidates: 4200,
    // Brush blows about and snags on open ground and against anything that
    // breaks the wind, rather than sitting in the wet lines. It is the one
    // scatter that legitimately covers open ground, so it keeps a real floor —
    // but it needs the stand field's permission like everything else, or it
    // re-creates the uniform pepper on its own. Round 4 squares that gate: at
    // `stand` alone a 0.5 mean noise passed half of every candidate everywhere,
    // which is a pepper with a gentle modulation, not a set of clumps.
    accept: (s, r) => s.slope < 0.30 &&
      r() < (0.03 + (1 - s.density) * 0.34) * smooth01(s.standW, 0.42, 0.72) + s.shelter * 0.55,
    variants: brushGeos, tilt: 0.85, scaleRange: [0.42, 1.52],
  });
  brushGeos.forEach((g, i) => add(buildTiles(g, brush[i], brushMat, brushDepth, `brush-${i}`, 600)));
  counts.brush = brush.reduce((a, b) => a + b.length, 0);

  // ---- dead trees ---------------------------------------------------------
  // Trees keep the longest reach in the module and that is deliberate: a bare
  // tree standing against a ridgeline is a silhouette, not a speck, and it is
  // the single most legible MGSV composition there is. Fifty-odd of them over a
  // square kilometre cannot read as pepper.
  const treeGeos = [0, 1].map((i) => growPlant(deadTreeParams(3300 + i * 211)));
  const treeMat = branchMaterial(uniforms, BRANCH_COLORS.tree, SWAY.tree, 0.84);
  const treeDepth = matchingDepthMaterial(uniforms, SWAY.tree);
  const treeNear = scatterAnnulus({
    field, rng, rInner: 0, rOuter: 175, candidates: 3600,
    // Rare, and only where there is enough water to have grown one — which now
    // means the drainage lines specifically, since that is where the density
    // field puts its water.
    accept: (s, r) => s.slope < 0.34 && s.density > 0.20 && r() < 0.004 + s.density * 0.075,
    variants: treeGeos, tilt: 0.35, scaleRange: [0.85, 2.55], sink: 0.08,
  });
  treeGeos.forEach((g, i) => add(buildTiles(g, treeNear[i], treeMat, treeDepth, `tree-n${i}`, 500, 130)));

  const treeMatFar = branchMaterial(uniforms, BRANCH_COLORS.tree, SWAY.tree, 0.84, [560, 740]);
  const treeL1 = [growPlant(deadTreeParamsL1(3901))];
  const treeFar = scatterAnnulus({
    field, rng, rInner: 165, rOuter: 740, candidates: 13000,
    // Bias hard onto breaks of slope out here: a bare tree only pays for itself
    // when it is standing against the sky.
    accept: (s, r) => s.slope > 0.04 && s.slope < 0.32 && s.density > 0.14 && r() < 0.004 + s.density * 0.11,
    variants: treeL1, tilt: 0.3, scaleRange: [1.05, 3.15], sink: 0.10,
  });
  add(buildTiles(treeL1[0], treeFar[0], treeMatFar, null, 'tree-f', 560));
  counts.trees = treeNear.reduce((a, b) => a + b.length, 0) + treeFar[0].length;

  counts.tris = Math.round(tris);
  counts.draws = meshes.length;

  return { meshes, counts, brushGeos, brushMat, brushDepth };
}

/**
 * Tumbleweed — a handful of brush balls actually rolling downwind. Cheap (one
 * instanced draw, a couple of dozen instances) and it is the thing that stops the
 * flats from reading as a still photograph.
 */
export function createTumbleweed(field, uniforms, geo, mat, depthMat, count = 22, seed = 99) {
  const rng = mulberry32(seed);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthMat;
  mesh.frustumCulled = false;
  mesh.name = 'tumbleweed';

  const state = [];
  for (let i = 0; i < count; i++) {
    state.push({
      x: 0,
      z: 0,
      spin: rng() * Math.PI * 2,
      speed: 2.4 + rng() * 3.2,
      radius: 0.30 + rng() * 0.22,
      wobble: rng() * Math.PI * 2,
      fresh: true,
      lateral: (rng() - 0.5) * 0.5,
    });
  }

  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const qy = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const m = new THREE.Matrix4();

  function respawn(s, cam, wind, first) {
    // Enter from upwind so they always travel *into* frame.
    const spreadAngle = (rng() - 0.5) * 1.9;
    const cs = Math.cos(spreadAngle);
    const sn = Math.sin(spreadAngle);
    const dx = -(wind.x * cs - wind.y * sn);
    const dz = -(wind.x * sn + wind.y * cs);
    const d = first ? 12 + rng() * 90 : 70 + rng() * 45;
    s.x = cam.x + dx * d;
    s.z = cam.z + dz * d;
    s.fresh = false;
  }

  return {
    mesh,
    update(dt, elapsed, camera, wind) {
      for (let i = 0; i < count; i++) {
        const s = state[i];
        if (s.fresh) respawn(s, camera.position, wind, true);
        const gust = 0.65 + 0.35 * Math.sin(elapsed * 0.7 + s.wobble);
        const vx = (wind.x + -wind.y * s.lateral) * s.speed * gust;
        const vz = (wind.y + wind.x * s.lateral) * s.speed * gust;
        s.x += vx * dt;
        s.z += vz * dt;
        s.spin += (Math.hypot(vx, vz) / s.radius) * dt;

        const dx = s.x - camera.position.x;
        const dz = s.z - camera.position.z;
        if (dx * dx + dz * dz > 130 * 130) respawn(s, camera.position, wind, false);

        const h = field.surfaceY(s.x, s.z);
        // Bounce: it is a hollow ball of twigs, it never rolls smoothly.
        const hop = Math.abs(Math.sin(s.spin * 0.5)) * s.radius * 0.35;
        pos.set(s.x, h + s.radius * 0.85 + hop, s.z);
        axis.set(-wind.y, 0, wind.x).normalize();
        q.setFromAxisAngle(axis, s.spin);
        qy.setFromAxisAngle(_up, s.wobble + elapsed * 0.4);
        q.multiply(qy);
        scl.setScalar(s.radius / 0.32);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
