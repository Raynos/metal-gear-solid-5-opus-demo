import * as THREE from 'three';

/**
 * Character LOD scheduler.
 *
 * A skinned soldier is not cheap. Per character per frame the naive cost is
 * ~27 bone matrix composes, two two-bone IK solves for the arms, two for the
 * legs, ~15 terrain height queries, a `Skeleton.update()` (27 matrix multiplies
 * plus a bone-texture upload) for the beauty pass AND ONE MORE FOR EVERY SHADOW
 * CASCADE THE MESH LANDS IN, and 3-4 draw calls each in every one of those
 * passes. A 15-man garrison pays all of that whether it is 4 m from the lens or
 * 400 m away and two pixels tall.
 *
 * This decides, per character per frame, how much of that to actually do. Four
 * things are scaled independently, because they have very different costs and
 * very different visibility:
 *
 *  1. UPDATE RATE. Tier 0 every frame, then every 2 / 3 / 6 frames. Skipped
 *     frames accumulate their dt, so a tier-3 character animates at the right
 *     speed, just at 10 Hz. Nothing about the pose is wrong; it is sampled
 *     coarsely.
 *  2. IK LEVEL. Foot planting and the hip solve go first (tier 2+), then the
 *     per-foot ground-normal query (tier 1+). The arms are never dropped: the
 *     rifle is skinned to `handR`, so an unsolved arm does not degrade the
 *     pose, it detaches the weapon and points it at the sky.
 *  3. SKELETON UPLOAD. `Skeleton.update()` is gated behind a dirty flag, so a
 *     character whose pose did not change this frame does not rebuild its 27
 *     bone matrices and re-upload the bone texture. (three already dedupes this
 *     to once per `renderer.render()` via an internal frame map, so the saving
 *     is not against the shadow cascades — it is against the five frames out of
 *     every six on which a tier-3 character is not animated at all.)
 *  4. SHADOW CASTING. Past `shadowDist` the mesh stops casting. A guard 90 m
 *     out contributes a shadow a couple of pixels wide, and removing him takes
 *     3-4 draw calls and his whole triangle count out of the cascade renders.
 *
 * Off-screen characters are demoted two tiers rather than frozen: they can
 * still be inside a shadow cascade, and a guard who was walking when he left
 * the frame has to still be walking when he comes back.
 */

const _sphere = new THREE.Sphere();
const _projScreen = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _camPos = new THREE.Vector3();

/** Distance in metres at which each tier begins. */
const TIER_DIST = [14, 34, 78];
/** Frames between updates, per tier. */
const TIER_INTERVAL = [1, 2, 3, 6];
/** Hysteresis band so a character hovering on a boundary does not oscillate. */
const HYST = 2.5;

export class CharacterLOD {
  constructor(opts = {}) {
    this.frustum = new THREE.Frustum();
    this.camPos = new THREE.Vector3();
    this.frame = 0;
    /** Multiplies every distance threshold; < 1 is more aggressive. */
    this.bias = opts.bias ?? 1;
    /** Past this, stop casting shadows. */
    this.shadowDist = opts.shadowDist ?? 95;
    this.enabled = opts.enabled !== false;
    this.counts = [0, 0, 0, 0];
    this.updated = 0;
  }

  /** Call once per frame before evaluating any character. */
  begin(camera) {
    this.frame++;
    camera.updateMatrixWorld();
    camera.getWorldPosition(_camPos);
    this.camPos.copy(_camPos);
    // Build the inverse here rather than trusting `camera.matrixWorldInverse`:
    // the renderer refreshes that during `render()`, which is after this system
    // runs, and on the first frame of a shot it is still the previous pose.
    _inv.copy(camera.matrixWorld).invert();
    _projScreen.multiplyMatrices(camera.projectionMatrix, _inv);
    this.frustum.setFromProjectionMatrix(_projScreen);
    this.counts[0] = this.counts[1] = this.counts[2] = this.counts[3] = 0;
    this.updated = 0;
  }

  /**
   * Decide what `ch` gets this frame. Returns null to skip it entirely, or
   * `{ dt, ik }` where `dt` is the accumulated time since its last update and
   * `ik` is 2 (full), 1 (no per-foot normals) or 0 (no foot IK at all).
   */
  evaluate(ch, dt) {
    let s = ch.lodState;
    if (!s) {
      s = ch.lodState = { tier: 0, acc: 0, next: 0, visible: true, dist: 0, shadow: true };
      // Stagger the first update across characters so a 15-man garrison does
      // not spike every sixth frame with all of them at once.
      s.next = this.frame + ((ch.index ?? 0) * 5 + (ch.name?.length ?? 0)) % 6;
    }
    s.acc += dt;
    if (!this.enabled) {
      // A true "no LOD" baseline, not just "stop demoting": put the full
      // geometry and shadow casting back, or an A/B against this measures a
      // half-disabled scheduler.
      if (ch.setDetailLow) ch.setDetailLow(false);
      if (!s.shadow) {
        s.shadow = true;
        ch.mesh.castShadow = true;
      }
      const out = { dt: s.acc, ik: 2 };
      s.acc = 0;
      s.tier = 0;
      this.counts[0]++;
      this.updated++;
      return out;
    }

    const scale = ch.root.scale.x || 1;
    _sphere.center.set(ch.position.x, (ch.groundY ?? 0) + 0.95 * scale, ch.position.z);
    // Generous: covers a raised weapon, a prone crawl and a CQC lunge.
    _sphere.radius = 1.9 * scale;
    const visible = this.frustum.intersectsSphere(_sphere);
    const dist = Math.sqrt(
      (_sphere.center.x - this.camPos.x) ** 2 +
      (_sphere.center.y - this.camPos.y) ** 2 +
      (_sphere.center.z - this.camPos.z) ** 2,
    );
    s.visible = visible;
    s.dist = dist;

    // Hysteresis: crossing outward needs to clear the boundary by HYST metres.
    let tier = 3;
    for (let i = 0; i < TIER_DIST.length; i++) {
      const edge = TIER_DIST[i] * this.bias + (s.tier > i ? HYST : 0);
      if (dist < edge) {
        tier = i;
        break;
      }
    }
    if (!visible) tier = Math.min(3, tier + 2);
    s.tier = tier;
    this.counts[tier]++;

    // Shadow casting is a per-object flag, so flipping it is free and it takes
    // the whole mesh out of every cascade render at once.
    const wantShadow = dist < this.shadowDist * this.bias;
    if (wantShadow !== s.shadow) {
      s.shadow = wantShadow;
      ch.mesh.castShadow = wantShadow;
    }

    // The distance geometry. This is the single largest saving here — a
    // character is ~44 k triangles and 80% of that is lofted cloth, so trading
    // ring count for a silhouette nobody can resolve at 34 m is worth far more
    // than anything the update-rate scheduling below saves. Keyed on the same
    // hysteresis band as the tier so it cannot flicker across the boundary.
    if (ch.setDetailLow) ch.setDetailLow(tier >= 2);

    const interval = TIER_INTERVAL[tier];
    if (interval > 1 && this.frame < s.next) return null;
    s.next = this.frame + interval;

    const out = { dt: s.acc, ik: tier === 0 ? 2 : tier === 1 ? 1 : 0 };
    s.acc = 0;
    this.updated++;
    return out;
  }

  /** Telemetry for the perf probe. */
  stats() {
    return { t0: this.counts[0], t1: this.counts[1], t2: this.counts[2], t3: this.counts[3], updated: this.updated };
  }
}

/**
 * Gate `Skeleton.update()` behind a dirty flag.
 *
 * three calls `skeleton.update()` from `renderBufferDirect`, deduped to once per
 * `renderer.render()` — but that is once per FRAME, and a character the LOD
 * scheduler is animating at 10 Hz still pays a full 27-matrix rebuild and a
 * bone-texture upload on all sixty. Five out of every six of those are
 * recomputing a pose that did not move.
 *
 * The flag is raised by the animator whenever it poses. Correctness rests on
 * the fact that `Skeleton.update()` reads nothing but `bone.matrixWorld`, and
 * those only change when we change them.
 */
export function gateSkeleton(skeleton) {
  const base = skeleton.update.bind(skeleton);
  skeleton.poseDirty = true;
  skeleton.update = function gatedUpdate() {
    if (!this.poseDirty) return;
    this.poseDirty = false;
    base();
  };
  return skeleton;
}
