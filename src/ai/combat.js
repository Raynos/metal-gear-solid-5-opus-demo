import * as THREE from 'three';

/**
 * What happens when a guard pulls the trigger.
 *
 * Until round 9 `onGuardFire` published a cone half-angle and left the question
 * of whether anything was hit to whoever listened — and nobody listened, so
 * eight men could stand in the open emptying magazines into the player for as
 * long as he cared to stand there. A stealth game whose alert state cannot kill
 * you is a walking simulator with a meter.
 *
 * The rule this file exists to enforce: **failure has to be possible and it has
 * to be survivable.** Concretely, one rifleman with eyes on you at 15 m takes
 * about fourteen seconds to put a hundred points of damage into you, and three
 * of them take about five. That is long enough to break contact through a door
 * and short enough that standing in the open is a decision with a cost.
 *
 * Three things make the exchange readable rather than a dice roll:
 *
 *   - the FIRST round of a burst is the aimed one. Recoil walks the rest of the
 *     burst off, so a guard who is allowed to settle is far more dangerous than
 *     one who is being forced to re-acquire. Moving between bursts is the
 *     counter-play and it is worth about 35%.
 *   - MAGAZINES. Every guard runs dry after ~30 rounds and spends 2.6-3.4 s
 *     head-down. With three shooters that is a gap every few seconds, and the
 *     gaps are the only reason a firefight has a shape at all.
 *   - SUPPRESSION, both ways. Rounds cracking past a man cut his accuracy and
 *     pin him in cover; rounds cracking past the player are published so the
 *     HUD and the camera can react. Suppression is what lets the player win a
 *     fight he should lose, and it is what stops him winning one he shouldn't.
 */

export const BALLISTICS = {
  /** Rounds in a magazine before a reload. */
  magazine: 30,
  reloadMin: 2.6,
  reloadMax: 3.4,
  /** Rounds per burst, and the interval between rounds inside one. */
  burstMin: 2,
  burstMax: 4,
  burstGap: 0.105,
  /** Pause between bursts, before suppression stretches it. */
  restMin: 0.75,
  restMax: 1.85,

  /**
   * Hit chance at point blank against a standing, stationary man, before every
   * modifier below. Deliberately not 1.0: a conscript with an AK at 5 m under
   * fire misses, and a guard who never misses reads as a hitscan turret.
   */
  base: 0.70,
  /** Hit chance halves every this many metres of range. */
  rangeHalf: 22,
  /** Multiplier by the target's stance. A prone man is a much smaller card. */
  stance: { stand: 1.0, crouch: 0.68, prone: 0.42 },
  /** Multiplier at full sprint; a mover is harder than a statue. */
  moving: 0.58,
  /** In shade, at range, the guard is shooting at a shape he half-sees. */
  shadow: 0.72,
  /** Recoil: multiplier on the Nth round of a burst. Beyond the table, last. */
  burstWalk: [1.0, 0.72, 0.56, 0.46, 0.4],
  /** A suppressed shooter shoots badly. Full suppression costs this much. */
  suppressedBy: 0.62,
  /**
   * Damage per hit, on a 100-point player. Nine rounds to kill.
   *
   * Chosen from the measured end-to-end numbers, not from taste: at 11 it takes
   * one rifleman ~19 s to kill a stationary man at 15 m and three of them ~6 s.
   * Those are the two numbers that matter — 19 s is long enough that a single
   * guard who spots you is a problem you can solve by leaving, and 6 s is short
   * enough that standing in the open in front of a squad is fatal.
   */
  damage: 11,
  /** A round landing this close to the player counts as suppressing him. */
  nearMiss: 2.4,

  /** Suppression decay, per second, both on guards and on the player. */
  suppressDecay: 0.42,
  /** Suppression added to a guard per incoming round that lands near him. */
  suppressPerRound: 0.34,
  /** Suppression added to the player per round that cracks past. */
  playerPerRound: 0.22,
};

const _v = new THREE.Vector3();

/**
 * Probability that this round connects. Everything here is a lever the player
 * can pull — range, stance, movement, light, and how much return fire the
 * shooter is eating.
 */
export function hitChance(guard, target, dist, burstIndex) {
  const stance = target.ch?.anim?.stance ?? 'stand';
  const speed = target.speed ?? 0;
  const moveK = 1 - (1 - BALLISTICS.moving) * THREE.MathUtils.clamp(speed / 4.2, 0, 1);
  const walk = BALLISTICS.burstWalk[Math.min(burstIndex, BALLISTICS.burstWalk.length - 1)];
  const p = BALLISTICS.base
    * Math.pow(0.5, dist / BALLISTICS.rangeHalf)
    * (BALLISTICS.stance[stance] ?? 1)
    * moveK
    * (target.inShadow ? BALLISTICS.shadow : 1)
    * walk
    * (1 - BALLISTICS.suppressedBy * THREE.MathUtils.clamp(guard.suppression, 0, 1));
  return THREE.MathUtils.clamp(p, 0, 0.72);
}

/**
 * Where the round actually goes. A miss is not "nowhere": it lands somewhere
 * near the target, which is what the impact effects and the player's own
 * suppression are computed from.
 */
export function impactPoint(at, dist, rand, out = new THREE.Vector3()) {
  // A miss at 40 m is metres wide; a miss at 5 m is centimetres.
  const s = 0.18 + dist * 0.028;
  out.set(
    at.x + (rand() * 2 - 1) * s,
    at.y + (rand() * 2 - 1) * s * 0.6,
    at.z + (rand() * 2 - 1) * s,
  );
  return out;
}

/**
 * The magazine. Returns true if there is a round available to fire; starts a
 * reload and returns false if there is not.
 *
 * Kept here rather than in `Guard` so the whole exchange — chance, damage,
 * reload cadence — is one file that can be read and tuned as one thing.
 */
export function tryChamber(guard, rand) {
  if (guard.reloadT > 0) return false;
  if (guard.rounds > 0) return true;
  guard.rounds = BALLISTICS.magazine;
  guard.reloadT = BALLISTICS.reloadMin + rand() * (BALLISTICS.reloadMax - BALLISTICS.reloadMin);
  guard.burst = 0;
  return false;
}

/** Decay both suppression meters. Called once per guard per frame. */
export function decaySuppression(guard, dt) {
  if (guard.suppression > 0) {
    guard.suppression = Math.max(0, guard.suppression - BALLISTICS.suppressDecay * dt);
  }
  if (guard.reloadT > 0) guard.reloadT -= dt;
}

/**
 * Rounds cracking past a man pin him. Applied to every guard within `radius` of
 * the point a player round passed through — which is why shooting AT a guard
 * you cannot hit is still worth doing.
 */
export function suppressNear(guards, position, radius, amount) {
  for (const g of guards) {
    if (g.down) continue;
    const d = _v.set(
      g.ch.position.x - position.x, 0, g.ch.position.z - position.z,
    ).length();
    if (d > radius) continue;
    const k = 1 - d / radius;
    g.suppression = Math.min(1, g.suppression + amount * k);
    // Being shot at is information: he now knows roughly where it came from.
    g.awareHold = Math.max(g.awareHold, 1.2);
  }
}
