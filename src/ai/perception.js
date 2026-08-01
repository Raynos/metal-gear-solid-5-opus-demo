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
 * Calibration, standing still is the reference (`RATE` is meter units per
 * second, and the meter runs 0..1):
 *
 *   10 m, dead centre, standing, sunlit, walking    ~0.9 s to full
 *   30 m, 40 deg off axis, crouched, sunlit, still  ~7 s
 *   30 m, dead centre, prone, in shadow, still      never (below the leak rate)
 *   sprinting doubles the rate at any range
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
  /** Daylight, standing target, calm. Scaled by everything below. */
  range: 62,
  /** Multiplier on range by target stance. */
  stanceRange: { stand: 1.0, crouch: 0.72, prone: 0.42 },
  /** Multiplier on fill rate by target stance. */
  stanceRate: { stand: 1.0, crouch: 0.5, prone: 0.2 },
  /** An alerted guard is looking for you and looks further. */
  alertRange: 1.3,
  /** Fill rate at the ideal: point blank, centred, sunlit, standing. */
  gain: 1.15,
  /** Meter leak once the contact is lost, and how long before it starts. */
  decay: 0.22,
  hold: 1.6,
  /** Shadow multiplies the rate by this; open sun by 1. */
  shadow: 0.34,
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

/** Guard eye point: head bone if the rig is posed, else a nominal 1.6 m. */
export function eyeOf(ch, out = new THREE.Vector3()) {
  if (ch.rig?.byName?.get('head')) {
    ch.rig.byName.get('head').getWorldPosition(out);
    // The bone sits at the base of the skull; the eyes are a little forward.
    return out;
  }
  return out.set(ch.position.x, ch.position.y + 1.6, ch.position.z);
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
    * nightK
    * (target.inShadow ? 0.78 : 1);
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
  const distK = 1 - Math.pow(THREE.MathUtils.clamp(dist / range, 0, 1), 1.45);
  const speed = target.speed ?? 0;
  const moveK = 0.5 + THREE.MathUtils.clamp(speed / 4.5, 0, 1) * 1.5;
  const stanceK = SIGHT.stanceRate[stance] ?? 1;

  const rate = SIGHT.gain * angK * distK * stanceK * moveK * lightK * nightK
    * (guard.alerted ? 1.5 : 1);
  out.rate = rate;
  guard.awareHold = SIGHT.hold;
  guard.lastSeenAt.copy(_to);
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
