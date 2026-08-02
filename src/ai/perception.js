import * as THREE from 'three';

/**
 * Senses.
 *
 * The one rule this file exists to enforce: **detection is never instant**.
 * Awareness is a meter that fills at a rate, and the rate is the product of
 * every factor the player can act on — range, how far off the centre of the
 * guard's view you are, your stance, how fast you are moving, whether you are
 * standing in sunlight or in the shadow of a wall. Every one of those is a
 * lever the player can pull, which is the whole game. A boolean `canSee()`
 * would delete all of it.
 *
 * Calibration. Every one of these is measured by `node src/ai/_sim.mjs`, dead
 * centre in the focus cone, the guard doing nothing but stare (the meter runs
 * 0..1 and DETECT is 1.0):
 *
 *   15 m, standing, open, still          2.0 s      the reference
 *   15 m, standing, open, walking        1.0 s      movement doubles the rate
 *   40 m, crouched, in shadow, still    ~26 s       13x the reference
 *   40 m, prone, in shadow, still        never      out of range entirely
 *
 * ROUND 9 — the distance term. `distK` used to be `1 - (d/range)^1.45`, which
 * is nearly flat across the whole near field: 8 m read 0.95 and 40 m read 0.76,
 * so closing from 40 m to 8 m bought the player a 24% change in a curve he is
 * supposed to be playing against. Measured end to end that was 1.82 s at 8 m
 * against 3.62 s at 40 m — a factor of two across the entire usable range of
 * the mechanic, which is not a gradient, it is a rounding error.
 *
 * Two terms now multiply, because two different things actually fall off:
 *
 *   acuity     1 - (d/range)^2.2   how much of a man there is to resolve; goes
 *                                  hard to zero at the edge of his sight
 *   attention  26/(26 + d)         what fraction of the arc he is sweeping the
 *                                  target occupies. A man at 8 m is inside the
 *                                  glance; a man at 60 m has to be looked FOR.
 *
 * Together they give 1.6 s at 8 m and 27.8 s at 70 m: a 17x span instead of 2x.
 *
 * The other round-9 fix is that shadow used to be charged TWICE — it cut the
 * detection rate by 0.34 *and* the sight range by 0.78 — so a crouched man in
 * shade at 40 m fell off the end of a shortened range and was not merely hard
 * to see, he was invisible with no gradient at all. Shadow is a rate multiplier
 * only now. Range is set by stance and by night, which are the two things that
 * really change how far away a shape is resolvable.
 *
 * Awareness decays once the guard loses the contact, but only after a hold —
 * a man who just saw something does not immediately forget it.
 */

export const AWARE = {
  /** Guard's head snaps toward it. */
  NOTICE: 0.30,
  /** Guard breaks off and walks over to look. */
  SUSPECT: 0.66,
  /** Positive ID. Squad goes loud. */
  DETECT: 1.0,
};

export const SIGHT = {
  /** Full cone, degrees. MGSV guards are not owls. */
  fovDeg: 120,
  /** Inner cone where attention is concentrated. */
  focusDeg: 34,
  /**
   * Daylight, standing target, calm. Scaled by everything below.
   *
   * 62 m was too short once the player's insertion moved to 80-120 m out: he
   * arrived already inside the only band the mechanic had. A standing man in
   * open desert is resolvable a long way further than that; what should stop
   * the guard identifying him is TIME, which is what the two-term `distK`
   * below now supplies.
   */
  range: 76,
  /** Multiplier on range by target stance. */
  stanceRange: { stand: 1.0, crouch: 0.72, prone: 0.42 },
  /** Multiplier on fill rate by target stance. */
  stanceRate: { stand: 1.0, crouch: 0.55, prone: 0.2 },
  /** Range at which "attention" has halved — see the two-term distK. */
  attention: 26,
  /** How hard acuity collapses at the edge of sight. */
  acuityExp: 2.2,
  /** An alerted guard is looking for you and looks further. */
  alertRange: 1.3,
  /** Fill rate at the ideal: point blank, centred, sunlit, standing. */
  gain: 1.6,
  /** Meter leak once the contact is lost, and how long before it starts. */
  decay: 0.22,
  hold: 1.6,
  /** Shadow multiplies the RATE by this; open sun by 1. Range is not touched. */
  shadow: 0.45,
  /** Night multiplies range and rate by this (guards have torches, not eyes). */
  night: 0.42,
};

export const HEARING = {
  /** A noise of radius r is heard at r metres; walls halve it. */
  wallFalloff: 0.5,
  /** Awareness a heard noise adds directly. */
  bump: 0.34,
  /** How far the reported position wanders from the truth, per metre of range. */
  errorPerMetre: 0.11,
};

const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** Eye height above the man's own ground, by stance. */
const EYE_H = { stand: 1.62, crouch: 1.16, prone: 0.42, down: 0.3 };

/**
 * Guard eye point.
 *
 * ROUND 9 — this used to read the head BONE's world position when the rig
 * existed, falling back to `position.y + 1.6`. Both branches were wrong, and
 * the first one was catastrophic:
 *
 *   - `lod.js` gates the bone-matrix rebuild behind a dirty flag, so a
 *     character the LOD has parked does not have current bone world matrices
 *     and `getWorldPosition` returns the ORIGIN. Measured in the real compound:
 *     8 of 12 guards reported an eye at (0, 1.6, 0). Every line-of-sight test
 *     those men did was cast from the middle of the map, which means most of
 *     the garrison's vision was not merely inaccurate, it was unrelated to
 *     where they were standing.
 *   - the fallback used `position.y`, which on a Character is 0 — the ground is
 *     `groundY`. On a compound whose pad sits metres above the valley floor
 *     that puts the eye underground.
 *
 * Analytic, like `targetPoint` beside it: ground + a stance eye height, scaled
 * by the man's own build. No matrix decompose, no dependence on whether the
 * animator has run this frame, and it is the same answer at every LOD.
 */
export function eyeOf(ch, out = new THREE.Vector3()) {
  const s = ch?.anim?.stance ?? ch?.stance ?? 'stand';
  const g = ch?.groundY ?? ch?.position?.y ?? 0;
  const scale = ch?.root?.scale?.y ?? ch?.scale ?? 1;
  return out.set(ch.position.x, g + (EYE_H[s] ?? EYE_H.stand) * scale, ch.position.z);
}

/** Target's visible centre — chest for a standing man, much lower prone. */
export function targetPoint(ch, out = new THREE.Vector3()) {
  const s = ch?.anim?.stance ?? ch?.stance ?? 'stand';
  const h = s === 'prone' ? 0.34 : s === 'crouch' ? 0.85 : 1.28;
  // `groundY` is written by the animator every frame; position.y is not.
  const g = ch?.groundY ?? ch?.position?.y ?? 0;
  return out.set(ch.position.x, g + h, ch.position.z);
}

/**
 * One sense tick for one guard. `dt` is the wall time since THIS guard last
 * ticked, not the frame time — guards are sensed on a rotating schedule, so
 * the two are different numbers and using the frame's dt would make a guard's
 * detection speed depend on how many guards are alive.
 *
 * Returns the awareness delta and the diagnostics the debug overlay draws.
 */
export function senseVision(guard, target, ctx, dt) {
  const out = guard.vis;
  out.visible = false;
  out.rate = 0;
  out.dist = Infinity;
  if (!target || guard.down) return 0;

  eyeOf(guard.ch, _eye);
  targetPoint(target.ch, _to);
  _to.sub(_eye);
  const dist = _to.length();
  out.dist = dist;

  const stance = target.ch?.anim?.stance ?? 'stand';
  const lightK = target.inShadow ? SIGHT.shadow : 1;
  const night = ctx.night;
  const nightK = 1 - night * (1 - SIGHT.night);
  const range = SIGHT.range
    * (SIGHT.stanceRange[stance] ?? 1)
    * (guard.alerted ? SIGHT.alertRange : 1)
    * nightK;
  out.range = range;
  if (dist > range) return decay(guard, dt);

  // Facing is the guard's LOOK direction, not his body yaw: a guard who has
  // turned his head to scan really can catch you out of the corner of his eye,
  // and that is the behaviour that makes patrolling guards feel alive.
  const look = guard.lookYaw;
  _fwd.set(-Math.sin(look), 0, -Math.cos(look));
  const flat = Math.hypot(_to.x, _to.z) || 1e-4;
  const cosA = (_fwd.x * _to.x + _fwd.z * _to.z) / flat;
  const ang = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
  const half = THREE.MathUtils.degToRad(SIGHT.fovDeg) * 0.5;
  if (ang > half) return decay(guard, dt);

  _to.add(_eye);
  if (!ctx.grid.losClear(_eye.x, _eye.y, _eye.z, _to.x, _to.y, _to.z)) return decay(guard, dt);

  out.visible = true;

  // Angular term: flat across the focus cone, then falling to nothing at the
  // rim. Peripheral vision notices movement; it does not identify a man.
  const focus = THREE.MathUtils.degToRad(SIGHT.focusDeg) * 0.5;
  const angK = ang <= focus ? 1 : 1 - THREE.MathUtils.smoothstep(ang, focus, half) * 0.88;
  // Acuity x attention. See the header: one term for how much of a man is left
  // to resolve, one for how much of the guard's sweep he occupies.
  const acuity = 1 - Math.pow(THREE.MathUtils.clamp(dist / range, 0, 1), SIGHT.acuityExp);
  const distK = acuity * (SIGHT.attention / (SIGHT.attention + dist));
  const speed = target.speed ?? 0;
  const moveK = 0.5 + THREE.MathUtils.clamp(speed / 4.5, 0, 1) * 1.5;
  const stanceK = SIGHT.stanceRate[stance] ?? 1;

  const rate = SIGHT.gain * angK * distK * stanceK * moveK * lightK * nightK
    * (guard.alerted ? 1.5 : 1);
  out.rate = rate;
  guard.awareHold = SIGHT.hold;
  guard.lastSeenAt.copy(_to);
  // Why this man is suspicious, published for the HUD. Sight outranks a noise
  // he heard a moment ago: the strongest live channel is the one to show.
  guard.awareReason = 'sight';
  return rate * dt;
}

function decay(guard, dt) {
  guard.awareHold -= dt;
  if (guard.awareHold > 0) return 0;
  return -SIGHT.decay * dt;
}

/**
 * Hearing. A noise is a position, a radius and a kind; walls do not stop sound
 * but they do muffle it, so an occluded noise needs to be twice as loud.
 * The reported position is deliberately wrong by a distance that grows with
 * range — a guard who hears a shot at 40 m knows roughly where, not exactly.
 */
export function senseNoise(guard, noise, ctx) {
  if (guard.down || !noise) return null;
  const dx = noise.position.x - guard.ch.position.x;
  const dz = noise.position.z - guard.ch.position.z;
  const d = Math.hypot(dx, dz);
  if (d > noise.radius) return null;
  eyeOf(guard.ch, _eye);
  const clear = ctx.grid.losClear(
    _eye.x, _eye.y, _eye.z,
    noise.position.x, noise.position.y + 1.0, noise.position.z,
  );
  if (!clear && d > noise.radius * HEARING.wallFalloff) return null;
  const err = d * HEARING.errorPerMetre;
  const jx = ctx.rand() * 2 - 1;
  const jz = ctx.rand() * 2 - 1;
  return {
    kind: noise.kind,
    position: new THREE.Vector3(
      noise.position.x + jx * err,
      noise.position.y,
      noise.position.z + jz * err,
    ),
    strength: 1 - d / noise.radius,
  };
}
