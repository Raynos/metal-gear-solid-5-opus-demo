/**
 * Shots — canonical camera setups used by the screenshot harness and the visual
 * critic. Each shot is a fixed camera pose + time of day, so a change in the
 * renderer is always compared against the same framing.
 *
 * Keep these STABLE. Adding shots is fine; changing an existing shot's framing
 * invalidates every prior comparison.
 */
export const SHOTS = {
  // Wide establishing vista — tests terrain silhouette, aerial perspective, sky.
  vista: {
    position: [-64, 46, 118],
    target: [40, -6, -140],
    fov: 42,
    tod: 'afternoon',
    note: 'Establishing vista over the valley toward the ridgeline.',
  },
  // Golden-hour ridge — tests sun handling, bloom, rim light, long shadows.
  ridge: {
    position: [120, 22, 60],
    target: [-60, 8, -90],
    fov: 38,
    tod: 'dusk',
    note: 'Low sun raking across the ridge; long shadows.',
  },
  // Ground level — tests terrain material detail, AO, near-field noise.
  ground: {
    position: [6, 1.7, 14],
    target: [-30, 0.4, -26],
    fov: 55,
    tod: 'noon',
    note: 'Eye-level ground detail; sand/gravel material read.',
  },
  // Night infiltration — tests night grade, stars, artificial lights.
  night: {
    position: [-20, 3.2, 34],
    target: [8, 1.0, -20],
    fov: 50,
    tod: 'night',
    note: 'Night infiltration lighting; stars, moonlight, lamp pools.',
  },
  // Over-the-shoulder gameplay framing — the shot that most reads as "the game".
  gameplay: {
    position: [4.2, 2.35, 8.4],
    target: [-2.0, 1.35, -6.0],
    fov: 50,
    tod: 'afternoon',
    note: 'Third-person over-the-shoulder gameplay camera.',
  },
  // Outpost approach — tests structures, props, set dressing.
  outpost: {
    position: [58, 12, 72],
    target: [0, 2, 0],
    fov: 45,
    tod: 'afternoon',
    note: 'Approach to the enemy outpost; architecture and set dressing.',
  },
  // Dawn haze — tests volumetrics and light shafts.
  dawn: {
    position: [-90, 18, -40],
    target: [80, 26, -160],
    fov: 40,
    tod: 'dawn',
    note: 'Dawn haze with the sun near the horizon; god rays.',
  },
};

export const SHOT_NAMES = Object.keys(SHOTS);
