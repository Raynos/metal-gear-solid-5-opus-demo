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
  //
  // Round 3 raised the target 31 m. The old aim put the top of frame at +10.5
  // degrees, so the shot could only ever see the horizon cloud band — a deck at
  // 1.8 km altitude read at grazing elevation stacks into a solid white wall,
  // and that wall, not the sky dome, was what made this frame measure warmer
  // than its own horizon. Same camera, same subject, 30% of the frame is now
  // sky the dome actually draws.
  vista: {
    position: [-64, 46, 118],
    target: [48, 25, -160],
    fov: 42,
    tod: 'afternoon',
    note: 'Establishing vista over the valley toward the ridgeline.',
  },
  // Golden-hour ridge — tests sun handling, bloom, rim light, long shadows.
  ridge: {
    // Round 3 raised the target 10 m: the old aim spent the bottom 40% of the
    // frame on one unbroken hillside in shadow at 0.048 display luminance —
    // correctly lit, and nothing to look at.
    //
    // Round 4 swung the camera round to the sun's side of the compound and
    // dropped the aim 8 m. The round-3 framing spent the bottom fifth on bare
    // unbroken hillside — rows 1000-1080 measured mean 48.5, sd 1.92, a flat
    // wash carrying no information at all. Two candidate rigs were rendered and
    // measured before this one was picked (rows 1000-1080, dusk):
    //   round 3            mean 22.6  sd  7.8  grad 0.51   3% over L=40
    //   low + close (7 m)  mean 12.5  sd  1.4  grad 0.13   0% over L=40
    //   this one           mean 30.6  sd 21.0  grad 0.67  18% over L=40
    // Dropping the camera turned the wash black instead of filling it; what
    // actually works is putting the SUNLIT approach ground, the compound's lit
    // west flank and its water tower into the lower band, so the band carries a
    // real luminance range and a real silhouette instead of one value.
    position: [140, 20, 30],
    target: [-30, 10, -80],
    fov: 40,
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
  //
  // This is a RIG, not a viewpoint. Round 2 sat 4.6 m back and 2.4 m up with the
  // subject on the optical axis, which is the survival-sandbox camera (Rust,
  // DayZ), not MGSV's. The Phantom Pain's is close, at eye height, and puts the
  // soldier on the left third with the aim space open to the right; the legs
  // leave frame and that is correct — the subject is a foreground element, not
  // the whole composition.
  //
  // `subject` is the contract with src/characters: it stands the player at
  // `dist` along the view ray, pushed `lateral` metres to camera-RIGHT of the
  // camera (so it lands on the LEFT third), on whatever ground is there. The
  // position/target below are that rig solved over the outpost yard, which is
  // graded flat at y = -0.05.
  //   subject (1.48, 4.56) - forward*2.4 + right*0.72, eye 1.60, pitch -5 deg
  // which lands him with his spine on the 30% line and his head at 27% of frame
  // height, aim space open across the remaining two thirds.
  //
  // Round 4 rebuilt it as a hard local offset instead. The round-3 rig read as a
  // drone shot: the horizon sat at y=382 while the top of the player's head was
  // at y=612, i.e. the horizon floated half a body height ABOVE the character,
  // which only happens when the camera is well over head height and pitched
  // down. The rig is now (right 0.45, up 1.62, back 2.1) from the player ROOT,
  // aimed along its own heading at the height of his sternum (root + 1.45) —
  // 4.6 degrees of pitch, all of it geometric, none of it added to "keep the
  // ground in frame". Solved over the outpost yard (graded flat at y = -0.05)
  // for the same subject position, so nothing else about the shot moved:
  //   cam (2.723, 1.57, 6.312), subject (1.476, -0.05, 4.563)
  // Horizon lands at y=434 and the crown of the head at y=392 — the horizon
  // crosses BELOW the head, which is what an eye-height camera does.
  gameplay: {
    position: [2.723, 1.57, 6.312],
    target: [-1.247, 0.76, -2.868],
    fov: 45,
    tod: 'afternoon',
    subject: { dist: 2.1, lateral: 0.45, eye: 1.62 },
    // Autofocus point, UV with 0,0 at bottom-left: the soldier's chest.
    focus: [0.32, 0.42],
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
