import * as THREE from 'three';

/**
 * PlayerController — locomotion, stance and collision for the player character.
 *
 * It does not own a mesh. `src/characters` builds and animates the soldier;
 * this writes `position`, `yaw`, `anim.speed` and `anim.stance` into that
 * character every frame and the procedural animator turns them into a gait.
 * The contract is deliberately that narrow — the animator plants feet on the
 * terrain itself, so anything this module does to the root that the animator
 * disagrees with shows up immediately as a foot slide.
 *
 * FEEL is the deliverable, and feel lives in three numbers per state: the speed
 * it tops out at, the time constant it takes to get there, and the time
 * constant it takes to stop. They are separate on purpose. A sprint that starts
 * as fast as it stops reads weightless; a walk that stops as slowly as a sprint
 * reads like ice.
 */

const MAX_SLOPE = 1.19;      // tan(50 deg) — steeper than this is a cliff, not a hill
const SLOPE_PROBE = 0.45;    // metres ahead the slope test samples
const GRAVITY = 18.0;        // deliberately heavy; a floaty drop off a 400 mm kerb reads as a bug
const LEAN_REACH = 0.34;     // how far out of cover a peek moves the body

/**
 * Per-stance movement envelope.
 *   walk/run/sprint  top speed in m/s for each gait
 *   accel/brake      seconds to reach ~63% of the target / of a stop
 *   radius           body radius used against the obstacle field
 *   step             how tall an obstacle can be and still be walked over
 *   noise            multiplier on the noise this stance makes at speed
 */
const STANCE = {
  stand: { walk: 1.55, run: 3.55, sprint: 6.2, accel: 0.16, brake: 0.11, radius: 0.34, step: 0.45, noise: 1.0, turn: 0.09 },
  crouch: { walk: 1.05, run: 2.25, sprint: 2.25, accel: 0.14, brake: 0.09, radius: 0.34, step: 0.32, noise: 0.42, turn: 0.10 },
  prone: { walk: 0.5, run: 0.95, sprint: 0.95, accel: 0.30, brake: 0.16, radius: 0.30, step: 0.12, noise: 0.10, turn: 0.34 },
};

/** How long the body is committed to a stance change before it can move freely. */
const STANCE_TIME = { standcrouch: 0.30, crouchstand: 0.30, crouchprone: 0.55, pronecrouch: 0.70, standprone: 0.70, pronestand: 0.95 };

export class PlayerController {
  constructor({ character, ground, obstacles }) {
    this.ch = character;
    this.ground = ground;
    this.obstacles = obstacles;

    // Deliberately NOT the character's own vector. The animator seats the root
    // by querying the ground itself and expects `ch.position.y` to be zero, so
    // sharing the object would mean the controller's foot height is wiped every
    // frame by the very thing that needs it.
    this.position = character.position.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = character.yaw;
    this.footY = ground.heightAt(this.position.x, this.position.z);
    this.fallVel = 0;
    this.grounded = true;

    this.stance = 'stand';
    this.stanceTimer = 0;
    this.sprinting = false;
    /** How far the body is currently leaned out of cover, in metres. */
    this.leanOffset = 0;
    this._leanAxis = new THREE.Vector2(1, 0);
    this.speed = 0;
    /** 0..1 loudness right now; the AI module treats this as a hearing radius scale. */
    this.noise = 0;
    this._noisePulse = 0;
    this._lastPhase = 0;

    this._n2 = new THREE.Vector2();
  }

  /** Request a stance. Returns false when the body is mid-transition. */
  setStance(next) {
    if (next === this.stance) return true;
    if (this.stanceTimer > 0) return false;
    this.stanceTimer = STANCE_TIME[this.stance + next] ?? 0.3;
    this.stance = next;
    return true;
  }

  /** Cycle toward standing — what sprint or a jump-out does from prone. */
  standUp() {
    if (this.stance === 'prone') return this.setStance('crouch');
    if (this.stance === 'crouch') return this.setStance('stand');
    return true;
  }

  get env() {
    return STANCE[this.stance];
  }

  /**
   * @param {number} dt
   * @param {object} cmd
   *   moveX/moveY  camera-relative intent, |v| <= 1
   *   camYaw       where the camera is pointing
   *   walk/sprint  gait modifiers
   *   aiming       locks the body to the camera and caps speed
   *   faceYaw      when set, the body is driven to this heading regardless
   *   lockAxis     {x,z} unit tangent; movement is projected onto it (cover)
   *   frozen       no translation at all (CQC, takedown, stance commit)
   */
  update(dt, cmd) {
    const env = this.env;
    if (this.stanceTimer > 0) this.stanceTimer = Math.max(0, this.stanceTimer - dt);

    // --- desired velocity ---------------------------------------------------
    const mag = Math.min(1, Math.hypot(cmd.moveX, cmd.moveY));
    let top = 0;
    if (mag > 0.02) {
      const analogWalk = cmd.walk || mag < 0.62;
      // Sprint is a standing-only gait and it will not start from a stick that
      // is not pushed the whole way; a sprint you can trip into by leaning on
      // the stick is the classic way to blow a stealth approach by accident.
      this.sprinting = !!cmd.sprint && this.stance === 'stand' && !cmd.aiming && mag > 0.85 && !cmd.lockAxis;
      top = this.sprinting ? env.sprint : analogWalk ? env.walk : env.run;
      if (cmd.aiming) top = Math.min(top, env.walk * 0.9);
      if (cmd.maxSpeed !== undefined) top = Math.min(top, cmd.maxSpeed);
      if (this.stanceTimer > 0) top *= 0.35;     // still getting up / going down
      top *= mag < 0.62 ? Math.max(0.35, mag / 0.62) : 1;
    } else {
      this.sprinting = false;
    }

    const cy = Math.cos(cmd.camYaw);
    const sy = Math.sin(cmd.camYaw);
    // Camera-relative: +moveY is where the camera looks, +moveX is its right.
    let wx = cmd.moveX * cy - cmd.moveY * sy;
    let wz = -cmd.moveX * sy - cmd.moveY * cy;
    if (cmd.lockAxis) {
      // Pressed against cover: only the component along the wall survives.
      const t = wx * cmd.lockAxis.x + wz * cmd.lockAxis.z;
      wx = cmd.lockAxis.x * t;
      wz = cmd.lockAxis.z * t;
    }
    const dl = Math.hypot(wx, wz);
    if (dl > 1e-5) { wx /= dl; wz /= dl; }

    const dvx = wx * top;
    const dvz = wz * top;

    // Turning against your own momentum costs speed. Without this a sprint can
    // be reversed inside one frame, which is the single most weightless thing a
    // third-person controller can do.
    const vlen = Math.hypot(this.velocity.x, this.velocity.z);
    // Braking is speed-dependent. A flat brake constant measured 0.63 m to stop
    // from a 6.2 m/s sprint, which is a cartoon: a loaded soldier at that speed
    // takes two or three strides to kill it, and the extra distance is what
    // makes committing to a sprint inside a compound feel like a decision.
    let tau = top > 0.01
      ? env.accel
      : THREE.MathUtils.lerp(env.brake, env.brake * 3.4, THREE.MathUtils.clamp((vlen - env.run) / (env.sprint - env.run), 0, 1));
    if (top > 0.01 && vlen > 1.0) {
      const dot = (this.velocity.x * wx + this.velocity.z * wz) / vlen;
      if (dot < 0.3) tau = THREE.MathUtils.lerp(env.brake, env.accel * 2.2, Math.max(0, dot + 0.2));
    }
    if (this.sprinting && vlen < env.run) tau = 0.34;   // sprint takes a beat to wind up
    const k = 1 - Math.exp(-dt / Math.max(0.02, tau));
    this.velocity.x += (dvx - this.velocity.x) * k;
    this.velocity.z += (dvz - this.velocity.z) * k;
    if (cmd.frozen) this.velocity.set(0, 0, 0);

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.speed < 0.02) { this.velocity.x = 0; this.velocity.z = 0; this.speed = 0; }

    // --- move, one axis at a time so a wall slides instead of stopping -------
    if (!cmd.frozen && this.speed > 0) {
      this._step(this.velocity.x * dt, 0);
      this._step(0, this.velocity.z * dt);
    }
    this._lean(dt, cmd);
    this._unstick(dt);
    this._settleY(dt);

    // --- heading ------------------------------------------------------------
    let want = this.yaw;
    if (cmd.faceYaw !== undefined) want = cmd.faceYaw;
    else if (cmd.aiming) want = cmd.camYaw;
    else if (this.speed > 0.12) want = Math.atan2(-this.velocity.x, -this.velocity.z);
    // Slower to swing the further you are leaning into a run: a sprinting body
    // carves, it does not pivot.
    const turnTau = cmd.aiming || cmd.faceYaw !== undefined
      ? 0.05
      : THREE.MathUtils.lerp(env.turn, env.turn * 3.2, THREE.MathUtils.clamp(this.speed / env.run, 0, 1));
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-dt / turnTau));

    // --- publish into the character ----------------------------------------
    const ch = this.ch;
    ch.position.x = this.position.x;
    ch.position.z = this.position.z;
    ch.position.y = 0;                 // the animator seats the root on its own ground query
    ch.yaw = this.yaw;
    ch.anim.speed = this.speed;
    ch.anim.stance = this.stance;

    this._noise(dt, ch);
  }

  /** Try to translate by (dx, dz); leaves position untouched when blocked. */
  _step(dx, dz) {
    if (dx === 0 && dz === 0) return;
    const p = this.position;
    const nx = p.x + dx;
    const nz = p.z + dz;
    const env = this.env;
    const g = this.ground.heightAt(nx, nz);

    // Vertical obstruction: anything taller than the step height stops the body.
    const obs = this.obstacles ? this.obstacles.maxIn(nx, nz, env.radius) : -1e9;
    const surface = obs > g + 0.10 ? obs : g;
    if (surface > this.footY + env.step) {
      if (dx !== 0) this.velocity.x = 0;
      else this.velocity.z = 0;
      return;
    }

    // Slope: sampled at a fixed distance so the test does not get noisier as
    // the step gets shorter.
    const inv = 1 / Math.hypot(dx, dz);
    const px = nx + dx * inv * SLOPE_PROBE;
    const pz = nz + dz * inv * SLOPE_PROBE;
    const rise = this.ground.heightAt(px, pz) - g;
    if (rise / SLOPE_PROBE > MAX_SLOPE) {
      if (dx !== 0) this.velocity.x = 0;
      else this.velocity.z = 0;
      return;
    }

    p.x = nx;
    p.z = nz;
  }

  /**
   * Peeking out of cover, as a bounded OFFSET rather than a per-frame nudge.
   *
   * The offset is tracked so only the delta is applied, and the delta goes
   * through `_step` like any other movement — so leaning round a corner stops
   * at whatever is in the way instead of sliding the body through it, and
   * holding the peek does not walk the player along the wall forever.
   */
  _lean(dt, cmd) {
    const want = (cmd.lean ?? 0) * LEAN_REACH;
    if (want === 0 && this.leanOffset === 0) return;
    // The axis is latched off the cover tangent, so unwinding the lean after
    // cover is released travels back the way it came out.
    if (cmd.lockAxis) this._leanAxis.set(cmd.lockAxis.x, cmd.lockAxis.z);
    const d = (want - this.leanOffset) * (1 - Math.exp(-dt / 0.14));
    const px = this.position.x;
    const pz = this.position.z;
    this._step(this._leanAxis.x * d, 0);
    this._step(0, this._leanAxis.y * d);
    // Bank only the distance actually travelled: a lean into a corner must not
    // build up a debt that snaps the body sideways the moment it clears.
    this.leanOffset += (this.position.x - px) * this._leanAxis.x + (this.position.z - pz) * this._leanAxis.y;
    if (Math.abs(this.leanOffset) < 1e-4) this.leanOffset = 0;
  }

  /**
   * Escape hatch. If the body ever ends up inside geometry — a bake texel that
   * disagrees with the mesh, a stance change under a lintel, being shoved by a
   * scripted move — every candidate step is blocked and the player is welded in
   * place with no way out. Creeping along the outward normal always frees him.
   */
  _unstick(dt) {
    if (!this.obstacles?.ok) return;
    const env = this.env;
    if (this.obstacles.maxIn(this.position.x, this.position.z, env.radius * 0.55) <= this.footY + env.step) return;
    const n = this.obstacles.wallNormal(this.position.x, this.position.z, this.footY + 0.35, env.radius * 2.2, this._n2);
    if (!n) return;
    this.position.x += n.x * 1.4 * dt;
    this.position.z += n.y * 1.4 * dt;
  }

  /** Snap up onto ledges quickly, fall off them under gravity. */
  _settleY(dt) {
    const p = this.position;
    const g = this.ground.heightAt(p.x, p.z);
    const obs = this.obstacles ? this.obstacles.maxIn(p.x, p.z, this.env.radius * 0.7) : -1e9;
    const surface = obs > g + 0.10 ? obs : g;

    if (surface >= this.footY - 0.02) {
      // Rising ground: follow it, but over ~60 ms rather than instantly, so a
      // kerb is a hitch in the camera and not a teleport.
      this.footY += (surface - this.footY) * (1 - Math.exp(-dt / 0.06));
      this.fallVel = 0;
      this.grounded = true;
    } else {
      this.fallVel -= GRAVITY * dt;
      this.footY += this.fallVel * dt;
      if (this.footY <= surface) { this.footY = surface; this.fallVel = 0; this.grounded = true; }
      else this.grounded = false;
    }
    p.y = this.footY;
  }

  /**
   * Noise, 0..1, and what the AI actually wants: a radius in metres.
   *
   * Two sources. A continuous floor from gait and stance, and a pulse on every
   * footfall — the animator's gait phase crosses 0 and 0.5 on the two plants,
   * so reading it here costs nothing and means the noise a guard reacts to is
   * synchronised with the foot the player can see land.
   */
  _noise(dt, ch) {
    const env = this.env;
    const gait = THREE.MathUtils.clamp(this.speed / STANCE.stand.sprint, 0, 1);
    const floor = gait * env.noise * (this.sprinting ? 1.0 : 0.72);

    const phase = ch.anim?.phase ?? 0;
    const crossed = (this._lastPhase % 0.5) > (phase % 0.5);
    this._lastPhase = phase;
    if (crossed && this.speed > 0.4) this._noisePulse = Math.max(this._noisePulse, floor * 1.35);
    this._noisePulse = Math.max(0, this._noisePulse - dt * 2.6);

    this.noise = THREE.MathUtils.clamp(Math.max(floor, this._noisePulse), 0, 1);
  }

  /** Hearing radius in metres for the AI's senses. */
  get noiseRadius() {
    return this.noise * 26;
  }

  /** One-off loud event (a shot, a body dropping, a CQC slam). */
  addNoise(amount) {
    this._noisePulse = Math.max(this._noisePulse, amount);
  }
}

export { STANCE as STANCE_ENVELOPE };
