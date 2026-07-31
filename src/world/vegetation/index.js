import * as THREE from 'three';
import { VegField } from './VegField.js';
import { createGrass, GRASS_COLORS } from './Grass.js';
import { createScrub, createTumbleweed } from './Scrub.js';

/**
 * vegetation — ground cover for the Afghan highland.
 *
 * Three layers, one shared wind field:
 *   1. GPU-placed instanced grass in three LOD rings out to ~60 m (widening to
 *      ~480 m when the camera is well above the ground).
 *   2. Procedurally grown thorny scrub, dry brush and dead trees, instanced.
 *   3. A handful of tumbleweeds actually rolling downwind.
 *
 * The gust field is what ties it together — grass, scrub and trees all read the
 * same scrolling noise octaves, so a gust crosses the whole landscape as one
 * wave rather than as a lot of independent wobbling.
 *
 * Placement is driven by Terrain's baked erosion channels, so grass thickens
 * along the drainage lines the terrain simulation actually carved, breaks into
 * tussock clumps on the flats, and is absent from bedrock, talus and steep faces.
 */

/** Wind blows down the valley from the north-west, as it does on the real map. */
const WIND_AZIMUTH = 2.25;
const WIND_STRENGTH = 0.20;

export async function install(world) {
  const { engine, scene, terrain, lighting } = world;

  const field = new VegField(terrain);

  const wd = new THREE.Vector2(Math.cos(WIND_AZIMUTH), Math.sin(WIND_AZIMUTH)).normalize();

  // Shared uniform objects: one write per frame re-tunes every vegetation shader.
  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector4(wd.x, wd.y, WIND_STRENGTH, 1.0) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.75) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uTranslucency: { value: 1.30 },
    uHeightMap: { value: field.heightTex },
    uSurfMap: { value: field.surfTex },
    uGridInfo: { value: field.info },
    uGrassLight: { value: GRASS_COLORS.light },
    uGrassDark: { value: GRASS_COLORS.dark },
  };

  const grass = createGrass(field, uniforms);
  for (const m of grass.meshes) scene.add(m);

  const scrub = createScrub(field, uniforms);
  for (const m of scrub.meshes) scene.add(m);

  const tumble = createTumbleweed(field, uniforms, scrub.brushGeos[0], scrub.brushMat, scrub.brushDepth);
  scene.add(tumble.mesh);

  // Prime the field on the boot camera so the very first frame is already dressed.
  grass.update(engine.camera);
  tumble.update(0, 0, engine.camera, wd);

  const sunColor = new THREE.Color();
  engine.addSystem({
    order: 20,
    update(dt, e) {
      uniforms.uTime.value = e.elapsed;
      grass.update(e.camera);
      tumble.update(Math.min(dt, 0.05), e.elapsed, e.camera, wd);

      if (lighting) {
        uniforms.uSunDir.value.copy(lighting.sunDirection);
        sunColor.copy(lighting.sun.color).multiplyScalar(lighting.sun.intensity);
        uniforms.uSunColor.value.set(sunColor.r, sunColor.g, sunColor.b);
      }
    },
  });

  const stats = {
    grassInstances: grass.meshes.reduce((a, m) => a + m.count, 0),
    grassTriangles: grass.meshes.reduce((a, m) => a + (m.geometry.index.count / 3) * m.count, 0),
    ...scrub.counts,
  };
  console.info('[vegetation]', stats);

  return { field, grass, scrub, tumble, uniforms, stats };
}
