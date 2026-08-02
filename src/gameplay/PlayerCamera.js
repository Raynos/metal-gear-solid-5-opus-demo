import * as THREE from 'three';

/**
 * The MGSV third-person camera.
 *
 * The rig is not invented here — it is the one solved for the canonical
 * `gameplay` shot in src/debug/Shots.js, read back out as an offset so the
 * playable camera and the frame this project is judged on are the same camera.
 * Reproducing the shot's numbers exactly:
 *
 *   cam    = root + up*1.62 + camRight*0.45 - camForward*2.1
 *   look   = (yaw, -0.081)
 *
 * with root (1.476, -0.05, 4.563) and yaw 0.4085 that evaluates to
 * (2.723, 1.57, 6.311) against the shot's (2.723, 1.57, 6.312), and the pitch
 * is the 4.6 degrees the shot's own comment derives geometrically: 0.17 m of
 * drop (eye 1.62 to sternum 1.45) over the 2.1 m boom.
 *
 * The subject lands on the left third because the camera is 0.45 m to the RIGHT
 * of him while looking parallel — atan(0.45/2.1) is 12.1 degrees of a 22.5
 * degree half-FOV, so he sits at about a third of frame width with the aim
 * space open across the other two. That single number is the shoulder swap.
 */

// Right shoulder. Every one of these is the shot's rig; do not "improve" them
// without re-solving the shot.
const RIG = {
  eye: 1.62,
  lat: 0.45,
  dist: 2.1,
  pitchBase: -0.0808,
  fov: 45,
};
// Shouldered: closer, tighter, a touch higher, and the subject moves further
// off-axis so the sight line is clear.
// Round 7: dist 1.30 -> 1.44 and lat 0.36 -> 0.41, measured off the rendered
// frame. At 1.30 the shoulder and the back of the skull took the whole left
// third out to 38% of frame width, and the head crowded the top edge. The extra
// 140 mm is 11% of the subject's screen height back and the extra lateral pushes
// what remains further off-axis; the aim space is unchanged because the boom
// still sits on the same side.
const AIM = { eye: 1.665, lat: 0.41, dist: 1.44, pitchBase: -0.055, fov: 33 };

const PITCH_MIN = -1.02;   // 58 degrees down
const PITCH_MAX = 0.78;    // 45 degrees up
const ORBIT = 0.75;        // how much of the pitch the boom follows

/**
 * The lens is a SPHERE, not a point.
 *
 * A point test on the boom passes the moment the camera's origin clears a wall
 * face, and at that pose the near plane — and about a third of the frustum — is
 * still on the far side of it. Measured on the shipped build, sweeping the
 * camera through a full turn at every open cell of the compound: 178 of 3744
 * poses (4.8%) had the lens inside geometry, the worst 1.12 m deep, and one
 * aimed pose filled 55% of the frame with the inside of a wall.
 *
 * 0.30 m is the frustum's own near-plane half-diagonal at 33 degrees, plus a
 * margin; SKIN is how far short of the contact the boom then stops.
 */
const LENS_R = 0.30;
const SKIN = 0.06;
const SWEEP_STEPS = 14;

export class PlayerCamera {
  constructor(camera, { obstacles, ground }) {
    this.camera = camera;
    this.obstacles = obstacles;
    this.ground = ground;

    this.yaw = 0;
    this.pitch = 0;
    this.shoulder = 1;          // +1 right, -1 left
    this._shoulderBlend = 1;
    this.aimBlend = 0;
    this.stanceDrop = 0;
    this._kick = 0;
    this._kickVel = 0;
    /** Fraction of the boom currently in use; 1 is fully extended. */
    this._boom = 1;

    this.follow = new THREE.Vector3();     // smoothed root
    this.lead = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._first = true;
  }

  /** Point the rig at a heading without a sweep — used when play mode starts. */
  reset(position, yaw) {
    this.yaw = yaw;
    this.pitch = 0;
    this.follow.copy(position);
    this.lead.set(0, 0, 0);
    this._boom = 1;
    this._first = true;
  }

  addLook(dx, dy) {
    this.yaw += dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy, PITCH_MIN, PITCH_MAX);
  }

  /** Weapon kick: a fast upward impulse that settles back over ~0.35 s. */
  recoil(amount) {
    this._kickVel += amount;
  }

  swapShoulder() {
    this.shoulder = -this.shoulder;
  }

  /**
   * @param {object} s player state
   *   position   root position (feet)
   *   velocity   horizontal velocity, for the lead
   *   aiming     0..1
   *   stance     'stand' | 'crouch' | 'prone'
   *   sprint     boolean, widens the lens
   */
  update(dt, s) {
    // --- spring-damped kick -------------------------------------------------
    this._kickVel -= this._kick * 90 * dt;
    this._kickVel *= Math.max(0, 1 - dt * 11);
    this._kick += this._kickVel * dt;

    // --- blends -------------------------------------------------------------
    const ease = (cur, target, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
    this.aimBlend = ease(this.aimBlend, s.aiming ? 1 : 0, 0.085);
    this._shoulderBlend = ease(this._shoulderBlend, this.shoulder, 0.16);
    const dropTarget = s.stance === 'prone' ? 1.02 : s.stance === 'crouch' ? 0.36 : 0;
    this.stanceDrop = ease(this.stanceDrop, dropTarget, 0.18);

    // --- what the rig is following -----------------------------------------
    // The camera leads the movement, but only SIDEWAYS.
    //
    // The first version slid the anchor along the whole velocity, and the
    // sprint frame showed why that is wrong: the boom is measured from the
    // anchor, so leading forward walks the camera 0.56 m closer to the body it
    // is following and the character grows to fill the frame at exactly the
    // moment you need to see where you are going. Only the component across the
    // heading survives, which is what makes the frame swing wide through a turn
    // — and the distance term below does the job the forward lead was reaching
    // for, by pulling BACK with speed instead of in.
    const lead = this._want.set(s.velocity.x * 0.13, 0, s.velocity.z * 0.13);
    const along = lead.x * -Math.sin(this.yaw) + lead.z * -Math.cos(this.yaw);
    lead.x += Math.sin(this.yaw) * along;
    lead.z += Math.cos(this.yaw) * along;
    if (lead.lengthSq() > 0.1225) lead.setLength(0.35);
    this.lead.lerp(lead, 1 - Math.exp(-dt / 0.22));

    if (this._first) {
      this.follow.copy(s.position);
      this._first = false;
    } else {
      // Tight, but not welded: 45 ms of give absorbs the step-up snap without
      // reading as lag on the stick.
      this.follow.lerp(s.position, 1 - Math.exp(-dt / 0.045));
    }

    // --- solve the boom -----------------------------------------------------
    const a = this.aimBlend;
    const eye = THREE.MathUtils.lerp(RIG.eye, AIM.eye, a) - this.stanceDrop;
    const lat = THREE.MathUtils.lerp(RIG.lat, AIM.lat, a) * this._shoulderBlend;
    // Speed pulls the camera back. Half a metre over the sprint range is barely
    // conscious and it is the whole reason a sprint reads as urgent rather than
    // as the same shot playing faster.
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    const dist = THREE.MathUtils.lerp(RIG.dist, AIM.dist, a) + (1 - a) * Math.min(0.5, speed * 0.075);
    const pitchBase = THREE.MathUtils.lerp(RIG.pitchBase, AIM.pitchBase, a);

    const yaw = this.yaw;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const fx = -sy;
    const fz = -cy;
    const rx = cy;
    const rz = -sy;

    const ax = this.follow.x + this.lead.x;
    const ay = this.follow.y + eye;
    const az = this.follow.z + this.lead.z;

    const orbit = this.pitch * ORBIT;
    const back = dist * Math.cos(orbit);
    const rise = -dist * Math.sin(orbit);

    // No lean term here on purpose. The peek moves the BODY out from behind
    // cover (PlayerController._lean, which routes it through the collision
    // test), and this rig follows the body — so the camera comes with it for
    // free and stays exactly as far behind his shoulder as it was. An extra
    // camera-space lean on top double-counted it, and because the body leans
    // along the cover tangent while the camera leaned along its own right, the
    // two disagreed whenever the wall was not square to the view: measured on
    // the peek state, the subject's head projected to x = -0.104, i.e. it had
    // left the frame entirely.
    this._want.set(
      ax + rx * lat - fx * back,
      ay + rise,
      az + rz * lat - fz * back,
    );

    // --- collision ----------------------------------------------------------
    // Sweep a sphere from the anchor outward and stop short of the first
    // contact. The anchor is inside the player's own chest, so it is always a
    // valid start point even when he is standing in a doorway.
    const t = this._sweep(ax, ay, az, this._want.x, this._want.y, this._want.z);
    // Asymmetric: pull in on the frame the contact happens (anything else lets
    // the wall through), ease back out over ~220 ms so clearing a doorpost is
    // not a snap zoom.
    this._boom = t < (this._boom ?? 1) ? t : ease(this._boom ?? 1, t, 0.22);
    const b = this._boom;
    this._pos.set(
      ax + (this._want.x - ax) * b,
      ay + (this._want.y - ay) * b,
      az + (this._want.z - az) * b,
    );
    // Never below the ground: a camera that dips under a slope behind the
    // player fills the frame with the inside of the terrain. The lens is a
    // sphere here too, so the clearance is its radius and not an eyeballed
    // 320 mm.
    const gy = this._groundNear(this._pos.x, this._pos.z) + LENS_R;
    if (this._pos.y < gy) this._pos.y = gy;

    this.camera.position.copy(this._pos);
    this._e.set(this.pitch + pitchBase + this._kick, yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this._e);

    // --- lens ---------------------------------------------------------------
    // A few degrees of extra width at a sprint is the cheapest speed cue there
    // is, and it goes away the moment the weapon comes up.
    const fov = THREE.MathUtils.lerp(RIG.fov + (s.sprint ? 4.5 : 0), AIM.fov, a);
    this._fov = ease(this._fov ?? fov, fov, 0.12);
    if (Math.abs(this.camera.fov - this._fov) > 0.02) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Highest ground under a disc of radius LENS_R — five taps, not one. */
  _groundNear(x, z) {
    const g = this.ground;
    const r = LENS_R;
    return Math.max(
      g.heightAt(x, z),
      g.heightAt(x + r, z), g.heightAt(x - r, z),
      g.heightAt(x, z + r), g.heightAt(x, z - r),
    );
  }

  /**
   * Fraction of the boom a sphere of radius LENS_R can travel before it touches
   * something, 0..1.
   *
   * Both surfaces are tested: the obstacle bake (walls, containers, the tower
   * legs) and the terrain itself. The old test looked at obstacles only and
   * clamped the terrain afterwards, which is why backing into a bank pushed the
   * lens up through the slope instead of shortening the boom.
   *
   * The floor is 2% rather than 0 only so the view direction stays defined; a
   * body shoved into a corner therefore collapses to a first-person-ish view,
   * which is what The Phantom Pain does too. Anything higher leaves the lens on
   * the wrong side of a wall in exactly the cramped places the collision test
   * exists for.
   */
  _sweep(ax, ay, az, bx, by, bz) {
    const f = this.obstacles;
    for (let i = 1; i <= SWEEP_STEPS; i++) {
      const t = i / SWEEP_STEPS;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      let solid = this._groundNear(x, z);
      if (f?.ok) {
        const o = f.maxIn(x, z, LENS_R);
        if (o > solid) solid = o;
      }
      if (solid > y - LENS_R) {
        // Back off to just before this sample, then by the skin.
        const len = Math.hypot(bx - ax, by - ay, bz - az) || 1;
        return Math.max(0.02, (i - 1) / SWEEP_STEPS - SKIN / len);
      }
    }
    return 1;
  }

  /**
   * Where the camera is looking, for the aim ray.
   *
   * Rebuilt from yaw/pitch rather than read off `camera.quaternion`, because
   * the transform is applied at the END of the frame (order 1100, after the
   * animator has seated the root) while the aim ray is needed at the start.
   * Reading the matrix would put the reticle one frame behind the stick — 16 ms
   * of lag on the one thing in the game that has to be exact.
   */
  forward(out = new THREE.Vector3()) {
    const pitch = this.pitch + THREE.MathUtils.lerp(RIG.pitchBase, AIM.pitchBase, this.aimBlend) + this._kick;
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(pitch), -Math.cos(this.yaw) * cp);
  }
}

export { RIG as CAMERA_RIG };
