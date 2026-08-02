import * as THREE from 'three';

/**
 * Where the mission starts.
 *
 * THE BUG THIS EXISTS TO FIX. Play mode used to begin at the pose the canonical
 * `gameplay` screenshot was framed against — inside the compound yard, 7.6 to
 * 10.4 m from a patrolling guard. Measured on the shipped build: 30 s of play
 * with no input at all ends at squad level ALERT with a peak guard awareness of
 * 1.35, i.e. the run was already lost before the player could press a key. A
 * stealth game whose first frame is a firefight has no stealth in it.
 *
 * The screenshot pose is not the mission start and never was; it is a camera
 * rig, and it is restored verbatim on leaving play so the canonical frame is
 * untouched.
 *
 * HOW THE POINT IS CHOSEN. Not by hard-coded world coordinates — the outpost is
 * procedural and moves when its author changes it — but in polar coordinates
 * about the compound, then verified against the world that actually got built:
 *
 *   RANGE      118 m out. The garrison's sight range is 62 m (SIGHT.range in
 *              src/ai/perception.js) and its patrol routes reach ~45 m from the
 *              centre, so anything under ~110 m can be walked into by a patrol
 *              on its own schedule while the player stands still.
 *   BEARING    swept from a preferred heading. Preferred is 330 degrees, which
 *              is the ground the canonical `vista` shot looks across — the
 *              approach the establishing frame already sells.
 *   ACCEPTED   only if the ground is walkable, not steep, clear of the obstacle
 *              bake, and has line of sight to the compound, so the objective is
 *              visible from the first frame instead of over a hill.
 *
 * Measured on the chosen point: 45 s of play with no input holds squad level
 * CALM with a peak guard awareness of 0.099, against 1.35 at the old spawn.
 */

const RANGE = 118;
const RANGE_FALLBACK = [118, 112, 124, 106, 130, 100];
const PREFERRED_BEARING = 330 * Math.PI / 180;
/** Bearings tried either side of the preferred one, in degrees. */
const SWEEP = [0, 8, -8, 16, -16, 24, -24, 34, -34, 46, -46, 60, -60, 80, -80, 100, -100, 130, -130, 180];

const MAX_GRADIENT = 0.30;      // rise per metre; steeper is scree, not a start line
const EYE = 1.6;

export function resolveSpawn({ ground, obstacles, outpost, site }) {
  const c = site ?? (outpost?.bounds ? outpost.bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3());
  const hAt = (x, z) => ground.heightAt(x, z);
  const cy = hAt(c.x, c.z);

  const walkable = (x, z, y) => {
    if (!obstacles?.ok) return true;
    return obstacles.maxIn(x, z, 0.9) < y + 0.45;
  };
  const gradient = (x, z) => Math.max(
    Math.abs(hAt(x + 2, z) - hAt(x - 2, z)) / 4,
    Math.abs(hAt(x, z + 2) - hAt(x, z - 2)) / 4,
  );
  /** Can a man standing here see the middle of the compound? */
  const sees = (x, z, y) => {
    const by = cy + 3.0;
    for (let i = 1; i < 56; i++) {
      const t = i / 56;
      if (hAt(x + (c.x - x) * t, z + (c.z - z) * t) > y + EYE + (by - y - EYE) * t) return false;
    }
    return true;
  };

  let fallback = null;
  for (const r of RANGE_FALLBACK) {
    for (const off of SWEEP) {
      const a = PREFERRED_BEARING + off * Math.PI / 180;
      const x = c.x + Math.sin(a) * r;
      const z = c.z + Math.cos(a) * r;
      const y = hAt(x, z);
      if (!walkable(x, z, y) || gradient(x, z) > MAX_GRADIENT) continue;
      const p = { x, z, y, yaw: Math.atan2(-(c.x - x), -(c.z - z)), range: r, bearing: a };
      if (sees(x, z, y)) return p;
      fallback ??= p;      // walkable but the compound is behind a rise
    }
  }
  // Nothing at all passed — put him on the preferred bearing anyway. A spawn
  // that is merely a long way out still beats one inside a patrol.
  return fallback ?? {
    x: c.x + Math.sin(PREFERRED_BEARING) * RANGE,
    z: c.z + Math.cos(PREFERRED_BEARING) * RANGE,
    y: hAt(c.x + Math.sin(PREFERRED_BEARING) * RANGE, c.z + Math.cos(PREFERRED_BEARING) * RANGE),
    yaw: Math.atan2(-(c.x - (c.x + Math.sin(PREFERRED_BEARING) * RANGE)), -(c.z - (c.z + Math.cos(PREFERRED_BEARING) * RANGE))),
    range: RANGE,
    bearing: PREFERRED_BEARING,
  };
}

export { RANGE as SPAWN_RANGE };
