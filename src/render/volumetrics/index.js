import { TerrainFields } from './TerrainFields.js';
import { VolumetricPass, ATMOS } from './VolumetricPass.js';
import { ParticleAtmosphere } from './Particles.js';

/**
 * volumetrics — the atmosphere-in-the-volume layer.
 *
 * Three cooperating pieces, all procedural, all linear-HDR:
 *
 *   TerrainFields       CPU-built lookup textures: terrain elevation and the
 *                       sun *shadow-height* field, which answers "is this point
 *                       in the air shadowed by a ridge?" in a single fetch at
 *                       any distance. Kilometre-scale god rays depend on it —
 *                       the engine's own shadow map only spans 240 m.
 *   VolumetricPass      half-res raymarch of the haze (aerial perspective +
 *                       shafts) and a cumulus slab, temporally accumulated and
 *                       composited into the HDR buffer by one in-scene quad.
 *   ParticleAtmosphere  ground dust motes and wind-driven sand streaming off
 *                       the ridge crests, as depth-faded instanced billboards.
 *
 * Published on `registry.volumetrics` so other modules can read the tuning or
 * borrow the depth/height textures.
 */
export async function install(world) {
  const fields = new TerrainFields(world.terrain, 512);
  fields.updateSun(world.lighting.sunDirection);

  const pass = new VolumetricPass(world, fields);
  // Aerial perspective is implemented here AND in RenderPipeline's prepare pass;
  // running both stacks two hazes. This module takes it so the haze, the cloud
  // deck and the light shafts share one set of atmosphere numbers. Set
  // `engine.pipeline.enabled.aerial = true` to hand it back — the pass detects
  // that and disables its own haze on the next frame.
  pass.claimHaze();
  world.engine.addSystem(pass);

  const particles = new ParticleAtmosphere(world, fields, pass);
  world.engine.addSystem(particles);

  return { fields, pass, particles, ATMOS };
}
