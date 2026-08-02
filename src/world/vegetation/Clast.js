import * as THREE from 'three';
import { GLSL_NOISE, GLSL_TERRAIN } from './shaderLib.js';

/**
 * Clast — the loose surface stone the near ground has never had.
 *
 * WHY THIS FILE EXISTS. Crop any reference frame's dirt at 3x and every pebble
 * is three things: a lit face, a dark face, and a contact shadow. Crop ours and
 * the pebbles are albedo-only marks painted into the terrain texture — no
 * shading gradient, casting nothing, identical no matter where the sun goes.
 * Measured across the round-9 shots, loose stone was **0.00%** of the near band
 * against a reference that runs 40-50% ground cover, and it is the single
 * biggest reason our ground-band local contrast measures 0.61-0.68x the
 * reference's at *every* scale from 2 to 64 px.
 *
 * The rock module already scatters stone, but it cannot fix this: `Scatter.js`
 * is a CPU placement over the whole map, and `CLEAR.gravel` refuses a chip
 * inside 24 m of the play centre precisely so the outpost has somewhere to
 * stand. The 0-15 m band the player actually looks at is, by construction,
 * empty. Filling it needs a *camera-relative* field, which is what this is.
 *
 * WHY IT LIVES IN vegetation/. It is the mineral half of ground cover and it is
 * built out of the vegetation module's machinery, not the rock module's: the
 * camera-snapped lattice, `VegField`'s baked height/pad textures (a pebble on
 * the compound apron has to sit on the *graded* surface, 33 m above the natural
 * heightfield), and the same shared uniform block. Duplicating that in
 * `rocks/` to satisfy a filename would have meant a second copy of the ground
 * query drifting out of step with the first. Both directories have one owner.
 *
 * Five rings, snapped to the camera in world space so a stone stays nailed to
 * its patch of ground as you walk:
 *
 *   A  cell 0.24 m    0.0 -   4.6 m   32 facets   casts
 *   B  cell 0.32 m    3.9 -  11.5 m    8 facets   casts
 *   C  cell 0.55 m   10.0 -  26.0 m    8 facets   casts
 *   D  cell 1.35 m   23.0 -  62.0 m    8 facets
 *   E  cell 2.60 m   56.0 - 116.0 m    8 facets   for the elevated cameras
 *
 * 22.9k instances, 214k triangles, 5 draws. Measured by ablation on the gameplay
 * pose with the camera MOVING, averaged over a full cascade refresh period:
 * **+10.25 draws, +430k triangles and +0.98 ms a frame** at 1920x1080, main pass
 * plus shadow. See probes/r8_clastcost.js and probes/r8_clastdraws.js.
 *
 * Three things make a stone read as *seated* rather than dropped, and all three
 * are cheap:
 *   - it is buried. A third to nine tenths of every body is under the surface,
 *     so its outline meets the ground at a waterline, not at a silhouette edge.
 *   - it is flat-shaded, so the facet turned to the sun and the facet turned
 *     away are two different values with a hard crease between them. That crease
 *     is the 1 cm structure the round-9 critique said the whole world was
 *     missing.
 *   - rings A, B and C cast into the shadow map. Cascade 0 is 2048 texels over
 *     ~40 m, i.e. 2 cm a texel, so a 15 cm stone throws a shadow that is
 *     genuinely several texels long.
 */

/**
 * An indexed octahedron, optionally subdivided once, with a per-vertex id.
 *
 * Indexed and *shared* matters: the shape is randomised per instance by pushing
 * each vertex radially by a hash of (vertex id, cell), and a vertex shared by
 * four faces has to move once for all of them or the body comes apart into
 * floating triangles. Flat shading is then taken from screen-space derivatives
 * in the fragment shader, which is what lets an arbitrary vertex displacement
 * keep exact facet normals for free.
 */
function buildClastGeo(subdivide) {
  /** @type {number[][]} */
  const verts = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  let faces = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];

  if (subdivide) {
    const mid = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a];
      const vb = verts[b];
      const m = [va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]];
      const l = Math.hypot(m[0], m[1], m[2]) || 1;
      verts.push([m[0] / l, m[1] / l, m[2] / l]);
      mid.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const out = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    faces = out;
  }

  const n = verts.length;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const vid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    // An octahedron is too regular to read as broken stone even before the
    // per-instance jitter, so the base body is already squashed off-axis.
    // Round 11: y 0.82 -> 0.86. This squash MULTIPLIES the per-family one in
    // CLAST_BODY, so a slab was being flattened twice and ended up 0.33 of its
    // own radius tall. The per-family number is the one that is supposed to say
    // slab; this one only says "not a sphere".
    const p = [v[0] * 1.0, v[1] * 0.86, v[2] * 0.88];
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    nrm[i * 3] = p[0] / l;
    nrm[i * 3 + 1] = p[1] / l;
    nrm[i * 3 + 2] = p[2] / l;
    vid[i] = i;
  }
  const idx = new Uint16Array(faces.length * 3);
  faces.forEach((f, i) => {
    idx[i * 3] = f[0];
    idx[i * 3 + 1] = f[1];
    idx[i * 3 + 2] = f[2];
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/**
 * Linear albedo of the five lithologies the ramp mixes between.
 *
 * The measured brief for this round was blunt: the daylight set carries 93.4%
 * of its chromatic mass in ONE hue octant against the reference's 54.2%, and it
 * has literally zero pixels above L* 85 in the ground band against the
 * reference's 2.8%. Both of those are properties of loose stone in the real
 * frames — a scree of broken limestone is not one colour, it is bleached
 * carbonate next to iron-stained chert next to a dark basalt cobble, and the
 * bleached fraction is what supplies the blown highlights. Round 11 warmed the
 * basalt from R/B 1.01 to 1.32 for the same reason it warmed the carbonate: a
 * neutral albedo lit by nothing but sky is a BLUE object, and at a low sun the
 * mid band came back as a scatter of small blue wedges. It is still by a
 * distance the coolest family here — the sand's own albedo is R/B 1.57 — so the
 * hue spread the round-9 brief asked for survives.
 *
 * `pale` is the brightest albedo in the project and it is a 13% MINORITY. The
 * first build gave it 0.76 and 22% and the ground came back a field of
 * polystyrene chips: in the real frames a pebble is within a stop of the sand it
 * lies on, and all its contrast comes from the facet turned away from the sun
 * and from the shadow it throws — not from its albedo.
 *
 * ROUND 11. It came back anyway, and the reason was HUE, not value. 0.535 was
 * picked against LIGHT_TRANSPORT.groundAlbedo's *luminance* and its R/B was left
 * at 1.15 — very nearly neutral — while the sand it lies on renders at R/B 1.43
 * under a warm sun. A neutral chip in a warm frame does not read as a pale
 * stone, it reads as a COOL one, and the eye separates by hue long before it
 * separates by value: the gameplay crop was white-blue plates lying on tan sand.
 * Measured on shots/before against a --hide clast ablation of the same build,
 * the clast pixels ran p50 +0.15 and p95 +0.48 stops over the ground median,
 * which is defensible, and still looked like polystyrene. The number was never
 * the problem.
 *
 * So the pale family is now WARM — R/B 1.39, on the sand's own hue line — and
 * its luminance is +0.11 stops over LIGHT_TRANSPORT.groundAlbedo rather than
 * -0.03. It is brighter than it was and it reads darker, because it no longer
 * detaches. The blown highlight still comes from the FACET, not the albedo: a
 * flat-shaded plane square to a 6-unit sun clears L* 85 at this reflectance
 * while the sand around it, which is never square to anything, does not.
 */
const LITHO = [
  new THREE.Vector3(0.545, 0.478, 0.392), // bleached carbonate — R/B 1.39
  new THREE.Vector3(0.505, 0.418, 0.282), // buff limestone     — R/B 1.79
  new THREE.Vector3(0.442, 0.263, 0.171), // iron-stained chert — R/B 2.58
  new THREE.Vector3(0.252, 0.230, 0.191), // dark basalt cobble — R/B 1.32
  new THREE.Vector3(0.318, 0.302, 0.181), // olive-khaki shale  — R/B 1.76
];
/** Cumulative selection weights for the five families above. */
const LITHO_CDF = [0.13, 0.47, 0.61, 0.77, 1.0];

/** Wind-blown fines. Same value the rock module uses for its dust film. */
const CLAST_DUST = new THREE.Vector3(0.588, 0.487, 0.336);

const CLAST_HEAD = /* glsl */ `
attribute float aVid;
attribute vec2 aCell;
uniform vec2 uFieldCell;
uniform vec4 uRing;      // (cellSize, gridHalf, innerStart, outerEnd)
uniform vec2 uRingFade;  // (innerEnd, outerStart)
uniform vec4 uSize;      // (radiusMin, log(max/min), densityGain, sinkPerMetre)
uniform vec4 uShape;     // (flakeFraction, vertexJitter, buryMin, buryRange)
uniform vec3 uLitho[5];
uniform vec4 uLithoCdf;
uniform vec3 uClastDust;
varying vec3 vClastCol;
varying float vClastAO;
varying float vClastRough;
`;

/**
 * Ground query, clast flavour: ONE pad fetch shared by the whole five-tap
 * stencil instead of one per tap.
 *
 * `vegGroundAt` costs five `vegHeightAt` calls, and each of those is a four-tap
 * bilinear height fetch PLUS a four-tap bilinear pad fetch — forty dependent
 * texture reads per vertex, before the surface mask and before the second
 * `vegHeightAt` the seating needs. This shader runs on ~200k vertices in the
 * main pass and again in every cascade that any ring casts into, and the ground
 * query was measurably the whole cost of the module.
 *
 * The approximation is free: the pad map is a 1.75 m grading surface and this
 * stencil is +/-1.6 m across, so the lift is flat to within a couple of
 * centimetres over it. 53 fetches a vertex becomes 25, and `gh` comes out of the
 * same stencil instead of being looked up a second time.
 */
const CLAST_GROUND = /* glsl */ `
vec3 clastGround(vec2 p, float e, float lift, out float gh) {
  float h0 = vegNaturalY(p);
  float hL = vegNaturalY(p - vec2(e, 0.0));
  float hR = vegNaturalY(p + vec2(e, 0.0));
  float hD = vegNaturalY(p - vec2(0.0, e));
  float hU = vegNaturalY(p + vec2(0.0, e));
  gh = h0 + lift;
  return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
}
`;

/**
 * Where loose stone is, how big it is, and what it is made of.
 *
 * Read against the same baked channels the vegetation masks use, because they
 * are the same physics: `scree` is talus that has not been carried away,
 * `rock` is bedrock breaking up into its own float, `accum` is the drainage
 * that sorts and concentrates it, and the pad map's `dev` channel is the
 * compound yard — which in every reference frame of an occupied FOB is not
 * bare dirt at all but a *laid gravel hardstand*, the densest clast in the
 * scene. `shelter` is the drift: the wind drops what it is carrying the moment
 * a wall breaks it, and grit collects against the foot of every structure and
 * every boulder. That last term is the one that seats objects for free.
 */
const CLAST_BODY = /* glsl */ `
  vec2 cellIdx = uFieldCell + aCell - uRing.y;
  vec2 jitter = vegHash22(cellIdx) - 0.5;
  vec2 wxz = cellIdx * uRing.x + jitter * uRing.x * 0.98;

  float dist = length(wxz - cameraPosition.xz);
  float ringFade = smoothstep(uRing.z, uRingFade.x, dist)
                 * (1.0 - smoothstep(uRingFade.y, uRing.w, dist));

  vec3 pad = vegPadAt(wxz);
  float gh;
  vec3 gn = clastGround(wxz, 1.6, pad.r, gh);
  float slope = 1.0 - gn.y;
  vec4 surf = vegSurfAt(wxz);

  // Two scales of desert pavement: 30 m fields of lag gravel with genuinely
  // swept ground between them, and a 4 m structure inside each field. Without
  // the coarse octave the stone is an even pepper, which is the failure mode
  // every previous scatter in this project has been pulled up for.
  float pave = vegFbm(wxz * 0.031 + 91.0, 3);
  float lag = vegFbm(wxz * 0.24 - 17.0, 2);
  float dens = smoothstep(0.26, 0.72, pave * 0.64 + lag * 0.36) * 0.62 + 0.34;
  dens += surf.b * 0.55;                              // talus: stone is the ground
  dens += surf.g * 0.42;                              // bedrock shedding float
  dens += smoothstep(0.20, 0.75, surf.a) * 0.26;      // wadi bedload
  dens += pad.g * 0.72;                               // graded hardstand
  dens += pad.b * 0.55;                               // drift against walls & rocks
  dens *= 1.0 - smoothstep(0.34, 0.66, slope);        // nothing rests on a face
  dens = clamp(dens * uSize.z, 0.0, 1.0);

  float pick = vegHash21(cellIdx + 41.9);
  vec2 r2 = vegHash22(cellIdx + 5.31);
  // The outer ring thins AND coarsens with range rather than shrinking to a
  // field of sub-pixel specks: past the fade only the big clasts survive, which
  // is also what a real lag surface does to the eye at distance.
  float coarse = smoothstep(uRingFade.y, uRing.w, dist);
  float alive = (pick < dens * (1.0 - coarse * 0.55) && ringFade > 0.02
                 && r2.y > coarse * 0.62) ? 1.0 : 0.0;

  vec3 gClastP = vec3(wxz.x, gh, wxz.y);
  vec3 gClastN = vec3(0.0, 1.0, 0.0);
  vClastCol = vec3(0.0);
  vClastAO = 1.0;
  vClastRough = 0.9;

  if (alive > 0.5) {
    // Log-uniform over a 7x span. A linear draw over that range piles everything
    // near the mean and the field reads as one stamped size; the runts are what
    // make the cobbles look like cobbles.
    float size = uSize.x * exp(uSize.y * r2.y);
    // A quarter of the population is a slab rather than a lump. Slabs are most
    // of what mgi-9's ground actually is, and they are the cheapest coverage in
    // the module: a third more footprint for the same eight triangles. Their
    // thickness was 0.24 in the first build and every one of them read as a
    // sheet of cardboard lying in the sand — a slab still has an edge, and the
    // edge is where its dark face is.
    //
    // ROUND 11: 0.40 -> 0.50, and the slab is less elongated with it. 0.24 was
    // cardboard and 0.40 is still a plate. Do the arithmetic on what a flake
    // actually SHOWS: the base geometry is squashed in y as well, so a flake
    // pokes out of the sand by 0.82*0.40*(1-bury) = 3 to 22 per cent of its own
    // radius while spanning 1.34 of it sideways. That is up to 20:1 between what
    // you see and what you see it across, and no amount of flat shading puts a
    // second facet inside a 20:1 sliver — the crease this whole module is built
    // around was BELOW the sand. What reached the frame was one polygon of one
    // value with a hard outline, which is the paper cut-out both the round-9 and
    // the round-11 critique named. A slab still has an edge; it has to be thick
    // enough that the edge is above the waterline.
    float flake = step(1.0 - uShape.x, vegHash21(cellIdx + 613.1));
    vec3 axes = vec3(mix(1.0, 1.24, flake), mix(0.74, 0.50, flake), mix(0.86, 1.14, flake));
    vec2 asp = 0.74 + 0.52 * vegHash22(cellIdx + 77.7);
    axes.x *= asp.x;
    axes.z *= asp.y;

    // Per-vertex radial jitter, hashed on the vertex id so every face sharing a
    // vertex agrees and the body stays closed. This is the whole shape library:
    // one geometry, a different broken solid at every instance.
    float vj = vegHash21(vec2(aVid * 3.77 + 0.5, cellIdx.x * 7.13 + cellIdx.y * 3.71));
    vec3 p = position * (1.0 - uShape.y + 2.0 * uShape.y * vj) * axes * size;

    // Lie down, then turn. Flakes lie nearly flat with the ground; lumps take a
    // hard random tilt, because a cobble that has been kicked once is not level.
    // Round 11: the flake term 0.14 -> 0.26. A slab lying dead level shows the
    // viewer exactly one face however many it has, and a field of them all lying
    // level shows one face all pointing the same way — which is why the flakes
    // caught the sky as a single sheet. A real lag surface is imbricated: the
    // clasts overlap and lean, and the lean is most of what breaks the sheet up.
    float tilt = mix(0.72, 0.26, flake) * (vegHash21(cellIdx + 205.3) - 0.42);
    float ta = vegHash21(cellIdx + 331.7) * 6.2831853;
    vec3 axis = normalize(vec3(cos(ta), 0.30, sin(ta)));
    float ct = cos(tilt), st = sin(tilt);
    p = p * ct + cross(axis, p) * st + axis * dot(axis, p) * (1.0 - ct);

    float rot = vegHash22(cellIdx + 19.3).x * 6.2831853;
    float cs = cos(rot), sn = sin(rot);
    p = vec3(cs * p.x - sn * p.z, p.y, sn * p.x + cs * p.z);

    // Seat it on the ground plane, then bury a quarter to three quarters of it.
    // Burial is what stops a scatter reading as objects DROPPED on a surface:
    // the outline meets the ground at a waterline, not at a silhouette edge.
    vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), gn, 0.85));
    vec3 tx = normalize(cross(vec3(0.0, 0.0, 1.0), up) + vec3(1e-5, 0.0, 0.0));
    // tz = cross(tx, up), NOT cross(up, tx). The grass rings use the latter and
    // get away with it because they are DoubleSide and carry authored normals; a
    // left-handed basis here has determinant -1, which reverses triangle winding,
    // so every front face is culled and flat shading — which reads the facet
    // normal off screen-space derivatives — hands back an inward-pointing normal.
    // The whole field renders as black chips. That was the first build.
    vec3 tz = cross(tx, up);
    p = mat3(tx, up, tz) * p;

    // Angular size of the body, in radians of its own radius. Two things hang
    // off it, and both are the same argument: a body covering three pixels
    // cannot show a facet, a crease or a contact shadow, so anything it does
    // with structure it does as aliasing.
    float fine = 1.0 - smoothstep(0.0016, 0.0058, size / max(dist, 0.5));
    // The first: sink the runts. Flat shading gives a small body a hard two-value
    // split across three pixels — a warm facet against a sky-blue one — and at
    // that size the split is confetti, not structure. Burying it further leaves
    // only the cap, which is one value, which is the honest LOD for a thing the
    // size of a pixel: be a mark on the ground rather than a badly sampled
    // solid. Costs almost no cover, because the silhouette lost is sub-pixel.
    float bury = min(0.94, uShape.z + uShape.w * vegHash21(cellIdx + 88.1) + fine * 0.28);
    // The terrain clipmap coarsens with range, so its drawn surface drifts from
    // the fine heightfield this samples. Sinking a little further with distance
    // is the safe direction of that error: a stone that sinks is a smaller
    // stone, a stone that rises is a floating one.
    float sink = size * axes.y * bury + dist * uSize.w;
    gClastP = vec3(wxz.x, gh - sink, wxz.y) + p;
    gClastN = normalize(p + vec3(0.0, 1e-4, 0.0));

    // ---- the waterline ----
    // How far up its OWN emergent height this vertex is: 0 where the body meets
    // the sand, 1 at its highest point. Round 9 divided by the raw radius, and
    // that is why the waterline was not doing its job. The radius is measured
    // before the axis squash and before burial, so a flake with axes.y 0.40
    // buried 0.7 pokes out by 0.06 of it and spent its entire visible height
    // inside the first 7% of a ramp that ran to 0.30 — every pixel of that body
    // got the same occlusion, and a solid carrying one value across its whole
    // silhouette is a paper cut-out whatever that value is. Normalising by what
    // the body actually shows makes the ramp the same fraction of every stone,
    // flake or cobble, near or far.
    float emerge = max(size * axes.y * (1.0 - bury), 1e-4);
    float above = clamp((gClastP.y - gh) / emerge, -1.0, 2.0);
    // ---- lithology ----
    // Lithology, biased AWAY from the bleached family with size. A 40 cm block
    // has been sitting there long enough to grow desert varnish; a 4 cm chip is
    // freshly broken and shows clean carbonate. Without the bias the pale family
    // lands on the largest bodies in the frame as often as the smallest, and a
    // 40 cm white slab at four metres is the single loudest object in the shot.
    //
    // ROUND 11 adds a SECOND bias, on a different axis: angular size, computed above. The world bias puts the bleached family on the SMALL
    // bodies, which is right geologically and wrong for the frame — the only
    // thing a three-pixel body can contribute is its albedo, and an albedo-only
    // pale mark on sand is exactly the painted pebble this module exists to
    // replace. The near crops were full of them. So the runts and the far rings
    // are pushed off the bleached family and further into the fines, and the
    // bleached family is left where it can pay for itself.
    float lh = vegHash21(cellIdx + 157.1);
    float lith = mix(lh, 0.42 + 0.58 * lh, max(r2.y, fine));
    vec3 alb = uLitho[4];
    if (lith < uLithoCdf.x) alb = uLitho[0];
    else if (lith < uLithoCdf.y) alb = uLitho[1];
    else if (lith < uLithoCdf.z) alb = uLitho[2];
    else if (lith < uLithoCdf.w) alb = uLitho[3];
    // Per-body value jitter inside the family, then a dust film. The film is a
    // mix toward the fines, not a multiply: a dusty stone loses saturation as
    // well as contrast, and a stone half-buried in a drift is dustier than one
    // sitting proud on swept pavement.
    // 0.78 + 0.44h let any family come out 22% brighter than its authored value,
    // and on the pale family that is what actually reached the frame. 0.80+0.32h
    // keeps the per-body variation that stops a lithology reading as one paint
    // chip and takes the top off the range.
    alb *= 0.80 + 0.32 * vegHash21(cellIdx + 233.9);
    // Fines pile against a stone, and they pile against the BOTTOM of it. The
    // waterline term is the drift: at the sand line the body is half silt and a
    // third of the way up it is stone again. That is what softens the outline
    // where it meets the ground — an edge that changes colour along its length
    // is an object sitting IN something, an edge that does not is a shape cut
    // out and laid on top.
    float dusty = clamp(0.17 + pad.b * 0.30 + bury * 0.22 + vegHash21(cellIdx + 401.3) * 0.22
                        + (1.0 - smoothstep(0.0, 0.45, above)) * 0.34
                        + fine * 0.26, 0.0, 0.82);
    vClastCol = mix(alb, uClastDust, dusty);

    // Below the waterline the stone is in its own contact shadow and wearing the
    // fines that piled against it. Round 11 hung this on the emergent fraction
    // and pushed the floor 0.62 -> 0.50: the old ramp darkened the base of a
    // stone by 11%, which is nothing, and a stone whose base is not darker than
    // its top has no contact with the ground at all. This is the one seating cue
    // that does not depend on the shadow map, so it is the only one rings D and
    // E have.
    //
    // The floor is 0.50 over a SHORT ramp. 0.34 over a long one was tried first
    // and it stacks with a facet that is already turned away from the sun: the
    // near bodies came back with a jet-black wedge down one side, which trades a
    // paper cut-out for a hole in the ground. Occlusion belongs AT the contact,
    // not across the lower half of the body.
    vClastAO = mix(0.50, 1.0, smoothstep(0.0, 0.36, above));

    // Roughness by BODY, not one value for the whole class. 60-70% of this world
    // renders as a single flat dielectric at roughness 0.87-0.99; a desert lag
    // surface is the opposite — wind-polished and varnished clasts sit next to
    // freshly broken ones, so the specular lobe changes from stone to stone.
    //
    // The floor is 0.55 and not 0.38, which is where it started. At 0.38 a flake
    // lying flat is a small mirror pointed at the sky, and in the NIGHT frame —
    // where the ground around it has almost no diffuse light to give — every one
    // of them came back as a bright hard-edged triangle. That is the same
    // confetti the grass was pulled up for in rounds 2 and 3, arriving through
    // the specular lobe instead of through albedo or translucency.
    //
    // Round 11: 0.55 -> 0.74. The same argument holds in DAYLIGHT and nobody had
    // looked. A flake lying flat at 0.55 against a sky-dominated environment
    // returns a broad specular lobe across its whole top facet, on top of an
    // albedo already at the top of the ground's range — the afternoon gameplay
    // crop was full of small plates reading a full stop brighter than the sand
    // at a sun angle where a diffuse horizontal face should read DARKER than it.
    // The sand around them is authored at 0.87-0.99; a wind-polished clast may
    // sit below that, but it does not sit two thirds of the way to a mirror.
    vClastRough = mix(0.74, 0.97, vegHash21(cellIdx + 509.7)) * mix(1.0, 1.06, dusty);
  }
`;

function injectClast(mat, shared, local, isDepth) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, local);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       ${CLAST_HEAD}
       ${GLSL_NOISE}
       ${GLSL_TERRAIN}
       ${CLAST_GROUND}
       vec3 gClastPos;
       vec3 gClastNrm;`,
    );
    if (isDepth) {
      // The depth shader only guarantees <begin_vertex>; <beginnormal_vertex> is
      // behind USE_DISPLACEMENTMAP. Everything goes in one block here.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `{ ${CLAST_BODY}
           gClastPos = gClastP; }
         vec3 transformed = gClastPos;`,
      );
    } else {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          `{ ${CLAST_BODY}
             gClastPos = gClastP;
             gClastNrm = gClastN; }
           vec3 objectNormal = gClastNrm;`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gClastPos;');

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vClastCol;
           varying float vClastAO;
           varying float vClastRough;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           diffuseColor.rgb *= vClastCol * vClastAO;`,
        )
        // Unconditional, and after <roughnessmap_fragment> so it is the last
        // word — that chunk assigns roughnessFactor outright.
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = vClastRough;`,
        );
    }
    mat.userData.shader = shader;
  };
}

function makeRing(shared, opts) {
  const { cellSize, grid, innerStart, innerEnd, outerStart, outerEnd, subdivide, casts, name } = opts;

  const geo = buildClastGeo(subdivide);
  // Emit only the lattice cells that fall inside the annulus. The corners of a
  // square lattice and the hole in the middle of a ring are 40-60% of it, and a
  // degenerate instance still runs a full vertex shader.
  const half = grid * 0.5;
  const rIn = Math.max(0, innerStart / cellSize) - 1.0;
  const rOut = outerEnd / cellSize + 1.0;
  const keep = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const d = Math.hypot(i + 0.5 - half, j + 0.5 - half);
      if (d < rIn || d > rOut) continue;
      keep.push(i, j);
    }
  }
  const count = keep.length / 2;
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(keep), 2));

  const local = {
    uFieldCell: { value: new THREE.Vector2() },
    uRing: { value: new THREE.Vector4(cellSize, half, innerStart, outerEnd) },
    uRingFade: { value: new THREE.Vector2(innerEnd, outerStart) },
    uSize: {
      value: new THREE.Vector4(
        opts.sizeMin,
        Math.log(opts.sizeMax / opts.sizeMin),
        opts.densityGain,
        opts.sinkPerMetre,
      ),
    },
    uShape: { value: new THREE.Vector4(opts.flake, opts.jitter, opts.buryMin, opts.buryRange) },
    uLitho: { value: LITHO },
    uLithoCdf: { value: new THREE.Vector4(...LITHO_CDF.slice(0, 4)) },
    uClastDust: { value: CLAST_DUST },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.0,
    // The whole point. A facet turned to the sun and the facet next to it turned
    // away have to be two values with a crease between them — that crease is the
    // centimetre-scale structure the critique measured as absent. Smooth normals
    // on a 12 cm body give one soft gradient, which is exactly what we already
    // had painted into the terrain albedo.
    flatShading: true,
    // A stone lying on open pavement sees very nearly the whole sky; what it
    // does not see is under it, and that is what vClastAO is for.
    // Round 11: 0.97 -> 0.70, which is what src/world/Terrain.js gives the ground
    // this stone is lying on. A pebble in a lag surface sees LESS sky than the
    // open ground next to it — its neighbours are in the way — so 35% more was
    // the wrong sign as well as the wrong size, and at a low sun, where the sky
    // is most of the irradiance, it is what tipped the flat facets cool.
    envMapIntensity: 0.70,
    dithering: true,
  });
  mat.userData.uniforms = local;
  injectClast(mat, shared, local, false);

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, m);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = casts;
  if (casts) {
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    injectClast(depth, shared, local, true);
    mesh.customDepthMaterial = depth;
  }
  mesh.name = name;
  mesh.userData.local = local;
  mesh.userData.base = { cellSize };
  return mesh;
}

/**
 * Ring table. Sizes are body *radii* in metres, so ring A runs 4 to 30 cm across
 * and ring D 14 cm to 1.0 m — the 3-25 cm band the reference ground is made of,
 * plus the occasional block.
 *
 * `densityGain` is the acceptance multiplier on the mask. Rings A and B sit near
 * 1.0 because that is the band the player reads texture in; C and D are pulled
 * down because their cells are eight and forty times the area and a stone that
 * covers a tenth of a pixel is cost with no signal.
 */
const RINGS = [
  {
    name: 'clast-a', cellSize: 0.24, grid: 44, subdivide: true, casts: true,
    innerStart: -1, innerEnd: 0, outerStart: 3.4, outerEnd: 4.6,
    sizeMin: 0.020, sizeMax: 0.115, densityGain: 1.30, sinkPerMetre: 0.0008,
    flake: 0.24, jitter: 0.40, buryMin: 0.36, buryRange: 0.40,
  },
  {
    name: 'clast-b', cellSize: 0.32, grid: 78, subdivide: false, casts: true,
    innerStart: 3.9, innerEnd: 5.0, outerStart: 9.0, outerEnd: 11.5,
    sizeMin: 0.026, sizeMax: 0.140, densityGain: 1.24, sinkPerMetre: 0.0010,
    flake: 0.25, jitter: 0.40, buryMin: 0.36, buryRange: 0.40,
  },
  // Casts as well. Cascade 0 reaches ~26 m, so the outer edge of this ring gets
  // nothing from the depth pass — but the body of it is the band the outpost and
  // gameplay cameras actually read texture in, and 8 triangles an instance makes
  // it the cheapest shadow in the module.
  {
    name: 'clast-c', cellSize: 0.55, grid: 100, subdivide: false, casts: true,
    innerStart: 10.0, innerEnd: 12.5, outerStart: 21.0, outerEnd: 26.0,
    sizeMin: 0.045, sizeMax: 0.205, densityGain: 1.02, sinkPerMetre: 0.0016,
    flake: 0.26, jitter: 0.38, buryMin: 0.38, buryRange: 0.38,
  },
  {
    name: 'clast-d', cellSize: 1.35, grid: 96, subdivide: false, casts: false,
    innerStart: 23.0, innerEnd: 28.0, outerStart: 50.0, outerEnd: 62.0,
    sizeMin: 0.085, sizeMax: 0.265, densityGain: 0.92, sinkPerMetre: 0.0022,
    flake: 0.27, jitter: 0.36, buryMin: 0.40, buryRange: 0.34,
  },
  // The elevated cameras — outpost and vista — never see the first four rings at
  // all: their whole visible yard is 35-110 m out. A fifth ring at 3.4 m spacing
  // is a stipple rather than a population of readable stones, which is the right
  // answer at 3 px a body, and 8 triangles an instance makes it nearly free.
  {
    name: 'clast-e', cellSize: 2.60, grid: 92, subdivide: false, casts: false,
    innerStart: 56.0, innerEnd: 66.0, outerStart: 96.0, outerEnd: 116.0,
    sizeMin: 0.145, sizeMax: 0.345, densityGain: 0.84, sinkPerMetre: 0.0026,
    flake: 0.28, jitter: 0.34, buryMin: 0.42, buryRange: 0.32,
  },
];

export function createClast(field, uniforms) {
  const meshes = RINGS.map((r) => makeRing(uniforms, r));
  let instances = 0;
  let triangles = 0;
  for (const m of meshes) {
    instances += m.count;
    triangles += (m.geometry.index.count / 3) * m.count;
  }
  return {
    meshes,
    stats: { clastDraws: meshes.length, clastInstances: instances, clastTriangles: triangles },
    update(camera) {
      for (const m of meshes) {
        const cs = m.userData.base.cellSize;
        m.userData.local.uFieldCell.value.set(
          Math.floor(camera.position.x / cs),
          Math.floor(camera.position.z / cs),
        );
      }
    },
  };
}

export { LITHO as CLAST_LITHOLOGY };
