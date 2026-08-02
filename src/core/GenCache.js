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
// Deliberately does NOT retain large buffers. The terrain blob is 214 MB, and
// holding it here after the caller has copied what it needs pins that much heap
// for the life of the page — which, with several worlds resident in one browser,
// is the difference between a comfortable and an oversubscribed machine. Small
// results are worth memoising; big ones are cheap to re-read from disk.
const MEMOISE_UNDER_BYTES = 8 * 1024 * 1024;
const memory = new Map();

// NOT gated on import.meta.env.DEV. The render daemon serves a production
// bundle via `vite preview`, where DEV is false — gating on it disabled the
// cache in exactly the situation it exists for, and the first version of this
// file silently wrote nothing.
//
// Instead the endpoint proves itself: a hit must come back as octet-stream. A
// dev/preview server with no middleware mounted answers unknown paths with the
// SPA fallback (index.html, status 200), which would otherwise be read as data.
//
// Gated on the ORIGIN being local, though, which is the one thing the
// prove-itself check cannot cover. A failed GET is free, but the PUT that
// follows a miss is not: the terrain blob is 214 MB, and on a deployed host
// there is no middleware to receive it, so every single visitor uploaded a
// fifth of a gigabyte to earn a 405. Dev and `vite preview` are both localhost,
// so this keeps the cache exactly where it is wired up and skips it everywhere
// it can only cost bandwidth.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
const available =
  typeof fetch === 'function' &&
  typeof window !== 'undefined' &&
  LOCAL_HOSTS.has(window.location?.hostname);

/** Cache any ArrayBuffer-backed result. `make()` may be sync or async. */
export async function cachedBuffer(key, make) {
  if (memory.has(key)) return memory.get(key);

  if (available) {
    try {
      const t0 = performance.now();
      const res = await fetch(BASE + encodeURIComponent(key));
      const type = res.headers.get('content-type') || '';
      if (res.ok && type.includes('octet-stream')) {
        const tHead = performance.now();
        const buf = await res.arrayBuffer();
        if (buf.byteLength) {
          stats.hits++;
          // Split the wait so it is attributable. The terrain blob is 224 MB
          // and is re-fetched on EVERY page load; before this there was no way
          // to say whether that time was the server, the transfer or the decode.
          stats.bytes += buf.byteLength;
          stats.headerMs += Math.round(tHead - t0);
          stats.bodyMs += Math.round(performance.now() - tHead);
          if (buf.byteLength < MEMOISE_UNDER_BYTES) memory.set(key, buf);
          return buf;
        }
      }
    } catch {
      /* cache is an optimisation; a miss is always safe */
    }
  }

  stats.misses++;
  const made = await make();
  const buf = made instanceof ArrayBuffer ? made : made.buffer;
  if (buf.byteLength < MEMOISE_UNDER_BYTES) memory.set(key, buf);

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
export const stats = { hits: 0, misses: 0, bytes: 0, headerMs: 0, bodyMs: 0 };
