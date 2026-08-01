/**
 * GenCache — memoise expensive world generation to disk across page loads.
 *
 * A world build is ~25.7 s and 11.6 s of that is the terrain heightfield plus
 * its hydraulic erosion sim. That work is deterministic, so paying it on every
 * page load is pure waste; with several agents iterating in parallel it was the
 * dominant cost in the whole project's inner loop.
 *
 * Usage — the key must include a version you bump when the generator changes,
 * so the cache invalidates exactly when the maths does and never when an
 * unrelated file moves:
 *
 *   import { cachedFloat32 } from '../core/GenCache.js';
 *
 *   this.heights = await cachedFloat32(
 *     `terrain-v7-${size}-${segments}-${seed}`,
 *     () => this._buildHeights(),          // only called on a miss
 *   );
 *
 * A miss, a fetch failure, or a production build all fall through to the
 * generator, so correctness never depends on the cache being available.
 */

const BASE = '/__gencache/';
const memory = new Map();

const available =
  typeof fetch === 'function' &&
  typeof window !== 'undefined' &&
  !!import.meta.env?.DEV;

/** Cache any ArrayBuffer-backed result. `make()` may be sync or async. */
export async function cachedBuffer(key, make) {
  if (memory.has(key)) return memory.get(key);

  if (available) {
    try {
      const res = await fetch(BASE + encodeURIComponent(key));
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength) {
          memory.set(key, buf);
          return buf;
        }
      }
    } catch {
      /* cache is an optimisation; a miss is always safe */
    }
  }

  const made = await make();
  const buf = made instanceof ArrayBuffer ? made : made.buffer;
  memory.set(key, buf);

  if (available) {
    // Fire and forget: never make the caller wait to populate the cache.
    fetch(BASE + encodeURIComponent(key), { method: 'PUT', body: buf }).catch(() => {});
  }
  return buf;
}

/** Convenience for the common case: a Float32Array heightfield or attribute. */
export async function cachedFloat32(key, make) {
  const buf = await cachedBuffer(key, async () => {
    const out = await make();
    return out instanceof Float32Array ? out : new Float32Array(out);
  });
  return new Float32Array(buf);
}

/** How much time this saved, for reporting in the perf probe. */
export const stats = { hits: 0, misses: 0 };
