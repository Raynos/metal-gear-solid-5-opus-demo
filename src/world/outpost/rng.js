/**
 * Deterministic PRNG. Every placement decision in the outpost runs through one of
 * these so the compound is byte-identical across reloads — the screenshot harness
 * compares frames, so "random" wear that changes each boot would make every diff
 * meaningless.
 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rng());
  rng.pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
  rng.chance = (p) => rng() < p;
  /** Signed jitter, biased toward zero — most props are only slightly off-square. */
  rng.jitter = (amp) => (rng() + rng() - 1) * amp;
  return rng;
}
