/**
 * audio module — owned by a single agent.
 *
 * Contract: export `install(world)`. It is called once at boot, in the fixed
 * order defined in src/main.js, after terrain/sky/lighting exist. Return an
 * object (or nothing). Anything needing a per-frame tick should call
 * `world.engine.addSystem({ order, update(dt, engine) {} })`.
 *
 * `world` provides: { engine, scene, sky, lighting, terrain, registry }
 *   - terrain.heightAt(x, z) / terrain.normalAt(x, z) for ground placement
 *   - registry: shared object other modules publish handles into
 *
 * Do NOT edit files outside this directory.
 */
export async function install(world) {
  return null;
}
