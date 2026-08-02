import * as THREE from 'three';
import { VegField } from './VegField.js';
import { createGrass, GRASS_COLORS } from './Grass.js';
import { createScrub, createTumbleweed } from './Scrub.js';
import { createClast } from './Clast.js';

/**
 * vegetation — ground cover for the Afghan highland.
 *
 * Four layers, one shared wind field:
 *   1. GPU-placed instanced grass in four LOD rings out to ~160 m (widening to
 *      ~630 m when the camera is well above the ground).
 *   2. Procedurally grown thorny scrub, dry brush and dead trees, instanced in
 *      three geometry tiers out to ~900 m.
 *   3. A handful of tumbleweeds actually rolling downwind.
 *   4. Loose surface CLAST — instanced pebbles in the 0-68 m band. Mineral, not
 *      vegetable, but it is ground cover by every measure that matters and it
 *      shares this module's lattice and ground query. See Clast.js.
 *
 * The gust field is what ties it together — grass, scrub and trees all read the
 * same scrolling noise octaves, so a gust crosses the whole landscape as one
 * wave rather than as a lot of independent wobbling.
 *
 * Placement is driven by Terrain's baked erosion channels *and* by the outpost's
 * earthworks. The second half of that is not optional: the compound is a graded
 * platform standing up to 33 m above the natural heightfield, with an apron
 * reaching 240 m. Round 1 rooted everything on `terrain.heightAt` and buried the
 * entire field — 17,000 tufts, all of them underground, in every frame the
 * critics looked at. See `VegField.attach`.
 */

/** Wind blows down the valley from the north-west, as it does on the real map. */
const WIND_AZIMUTH = 2.25;
const WIND_STRENGTH = 0.22;

const _sky = new THREE.Color();

export async function install(world) {
  const { engine, scene, terrain, lighting, registry } = world;

  const wd = new THREE.Vector2(Math.cos(WIND_AZIMUTH), Math.sin(WIND_AZIMUTH)).normalize();

  // The field needs the wind so its shelter bake can be a DRIFT rather than a
  // symmetric fringe — see VegField._splatFootprint.
  const field = new VegField(terrain, wd);

  // Shared uniform objects: one write per frame re-tunes every vegetation shader.
  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector4(wd.x, wd.y, WIND_STRENGTH, 1.0) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.75) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSkyColor: { value: new THREE.Vector3(0.10, 0.13, 0.18) },
    // (through-scatter gain, wrapped-sky gain).
    //
    // Round 2 called 0.52/0.18 "deliberately modest" and it was not. With the
    // forward lobe on top, the through-scatter peaked at 0.83 of a full frontal
    // sun hit — added on top of the standard BRDF, so a back-lit blade received
    // nearly twice what a front-lit one did. Under the dawn camera, which looks
    // straight into a 6.1-unit sun across the valley, that is the white
    // confetti. And the sky half is a constant that never reaches zero: it is
    // the reason a dead branch measured luminance 80 in a NIGHT frame.
    //
    // 0.26 is roughly the transmittance of a dry straw blade. 0.06 is what is
    // left of the wrapped-sky term once the IBL (envMapIntensity, also pulled
    // down) is allowed to do the ambient work it is there to do.
    // Round 4: 0.26 -> 0.30, and the distance taper in vegDryShading pulled in
    // hard (45-150 m instead of 90-300 m) at the same time. Dry straw really
    // does transmit about a third of what lands on it, and the lobe now carries
    // its own amber tint (VEG_TRANSMIT in shaderLib) rather than merely scaling
    // the reflected colour, so a back-lit blade goes amber instead of just
    // bright. Raising the gain without pulling the range in put a bright speck
    // on every distant bush in the dawn frame's shaded hillside — round 2's
    // white confetti by a different route. The sky half is untouched at 0.06;
    // that one is ungated and it is what made a dead branch measure luminance 80
    // in a NIGHT frame.
    uTranslucency: { value: new THREE.Vector2(0.30, 0.06) },
    uHeightMap: { value: field.heightTex },
    uSurfMap: { value: field.surfTex },
    uPadMap: { value: field.padTex },
    uGridInfo: { value: field.info },
    uPadInfo: { value: field.padInfo },
    uGrassLight: { value: GRASS_COLORS.light },
    uGrassDark: { value: GRASS_COLORS.dark },
  };

  const grass = createGrass(field, uniforms);
  for (const m of grass.meshes) scene.add(m);

  // Clast binds the same pad texture object grass does, so it can be built here
  // even though the pad map is not filled until `field.attach` on the first tick.
  const clast = createClast(field, uniforms);
  for (const m of clast.meshes) scene.add(m);

  const state = { scrub: null, tumble: null, built: false, stats: {} };

  /**
   * Everything woody is placed on the first simulation tick rather than during
   * install, because the outpost — whose earthworks decide where the ground
   * actually *is* — installs after this module. `engine.step(0)` runs during
   * boot, before the first render, so nothing is ever visibly missing.
   */
  function build() {
    field.attach(registry);
    const scrub = createScrub(field, uniforms);
    for (const m of scrub.meshes) scene.add(m);
    const tumble = createTumbleweed(field, uniforms, scrub.brushGeos[0], scrub.brushMat, scrub.brushDepth);
    scene.add(tumble.mesh);
    state.scrub = scrub;
    state.tumble = tumble;
    state.stats = {
      grassInstances: grass.meshes.reduce((a, m) => a + m.count, 0),
      grassTriangles: grass.meshes.reduce((a, m) => a + (m.geometry.index.count / 3) * m.count, 0),
      grassDraws: grass.meshes.length,
      ...clast.stats,
      ...scrub.counts,
    };
    console.info('[vegetation]', state.stats);
  }

  const sunColor = new THREE.Color();
  engine.addSystem({
    order: 20,
    update(dt, e) {
      if (!state.built) {
        state.built = true;
        // This runs inside the frame loop, where install()'s try/catch no longer
        // protects anything: an exception here would take down every system that
        // sorts after it. Grass alone is a survivable outcome; a dead loop is not.
        try {
          build();
        } catch (err) {
          console.error('[vegetation] deferred build failed:', err);
        }
      }
      uniforms.uTime.value = e.elapsed;
      grass.update(e.camera);
      clast.update(e.camera);
      state.tumble?.update(Math.min(dt, 0.05), e.elapsed, e.camera, wd);

      if (lighting) {
        uniforms.uSunDir.value.copy(lighting.sunDirection);
        sunColor.copy(lighting.sun.color).multiplyScalar(lighting.sun.intensity);
        uniforms.uSunColor.value.set(sunColor.r, sunColor.g, sunColor.b);
        // Lighting publishes the sky's average radiance for exactly this: the
        // hemisphere a blade sits under, in the same physical units as the sun.
        const sr = lighting.atmosphere?.skyRadiance;
        if (sr) uniforms.uSkyColor.value.set(sr[0], sr[1], sr[2]);
        else uniforms.uSkyColor.value.set(_sky.r, _sky.g, _sky.b);
      }
    },
  });

  return { field, grass, clast, uniforms, state, get scrub() { return state.scrub; }, get stats() { return state.stats; } };
}
