import * as THREE from 'three';
import { VegField } from './VegField.js';
import { createGrass, GRASS_COLORS } from './Grass.js';
import { createScrub, createTumbleweed } from './Scrub.js';

/**
 * vegetation — ground cover for the Afghan highland.
 *
 * Three layers, one shared wind field:
 *   1. GPU-placed instanced grass in four LOD rings out to ~160 m (widening to
 *      ~630 m when the camera is well above the ground).
 *   2. Procedurally grown thorny scrub, dry brush and dead trees, instanced in
 *      three geometry tiers out to ~900 m.
 *   3. A handful of tumbleweeds actually rolling downwind.
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

  const field = new VegField(terrain);

  const wd = new THREE.Vector2(Math.cos(WIND_AZIMUTH), Math.sin(WIND_AZIMUTH)).normalize();

  // Shared uniform objects: one write per frame re-tunes every vegetation shader.
  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector4(wd.x, wd.y, WIND_STRENGTH, 1.0) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.75) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSkyColor: { value: new THREE.Vector3(0.10, 0.13, 0.18) },
    // (through-scatter gain, wrapped-sky gain). Both are deliberately modest.
    // The sun is 5.0 in physical units here, so a through-scatter gain near 1
    // adds more light than the direct term ever could and every blade turns
    // into a glowing white spike — which is exactly what the first pass did.
    // The sky term is a bounce between neighbouring blades, not a second
    // ambient light: push it and the field goes milky and double-counts the IBL.
    uTranslucency: { value: new THREE.Vector2(0.52, 0.18) },
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

  return { field, grass, uniforms, state, get scrub() { return state.scrub; }, get stats() { return state.stats; } };
}
