import * as THREE from 'three';
import { Input } from '../core/Input.js';
import { ObstacleField } from './Obstacles.js';
import { PlayerController } from './PlayerController.js';
import { PlayerCamera } from './PlayerCamera.js';
import { StealthActions } from './Stealth.js';

/**
 * gameplay — the player.
 *
 * Installs an input map, a third-person controller, the MGSV over-the-shoulder
 * camera and the stealth verbs, and drives the soldier that src/characters
 * already built. It owns nothing on screen: every frame it writes position,
 * yaw, stance, speed and aim into that character and the procedural animator
 * turns them into a pose.
 *
 * MODE. Everything here is inert outside `world.gameState.mode === 'play'`.
 * 'godmode' is the free-fly camera in src/main.js AND the pose the screenshot
 * harness drives, so leaving a single listener or a single camera write alive
 * outside play mode is how every canonical shot in the project starts drifting.
 * Leaving play mode restores the player to the exact pose the `gameplay` shot
 * was framed against.
 *
 * ANIMATION CONTRACT with src/characters — the channels written on the player
 * character every frame, and the only ones any other module should read:
 *
 *   ch.position, ch.yaw          root placement (position.y stays 0; the
 *                                animator seats the root on its own ground)
 *   ch.anim.speed                metres/second, drives the gait
 *   ch.anim.stance               'stand' | 'crouch' | 'prone'
 *   ch.anim.aim                  0..1 blend to the shouldered pose
 *   ch.anim.aimTarget            world point the weapon is pointed at
 *   ch.anim.lookTarget           world point the head tracks
 *   ch.anim.action               'none' | 'takedown' | 'grab' | 'drag' | 'cover'
 *   ch.anim.actionTime           seconds left in that action, 0 when idle
 *   ch.anim.inCover, ch.anim.lean   pressed to cover, and the peek offset
 *
 * The last four are additive: nothing in src/characters reads them yet and
 * nothing breaks if it never does.
 */

export const ANIM_CHANNELS = [
  'speed', 'stance', 'aim', 'aimTarget', 'lookTarget', 'action', 'actionTime', 'inCover', 'lean',
];

/** Minimal event bus. The AI, HUD and audio modules subscribe; nobody polls. */
function makeEvents() {
  const listeners = new Set();
  return {
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(e) {
      for (const fn of listeners) {
        try {
          fn(e);
        } catch (err) {
          console.error('gameplay event listener failed:', err);
        }
      }
    },
  };
}

/**
 * src/main.js owns the mode seam. This is the fallback for a tree where that
 * has not landed yet: same shape, and it drives the free-fly flag through the
 * harness API so 'godmode' still means what it means.
 */
function resolveGameState(world) {
  if (world.gameState) return world.gameState;
  const listeners = new Set();
  let mode = 'menu';
  const gs = {
    get mode() {
      return mode;
    },
    setMode(next) {
      if (next === mode) return mode;
      const prev = mode;
      mode = next;
      window.__GAME?.setFreeFly?.(next === 'godmode');
      for (const fn of listeners) fn(next, prev);
      return mode;
    },
    onModeChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  world.gameState = gs;
  return gs;
}

/** Ground including the outpost's graded platform — see src/characters. */
function resolveGround(world) {
  const chars = world.registry?.characters;
  if (chars?.ground?.heightAt) return chars.ground;
  const terrain = world.terrain;
  const outpost = world.registry?.outpost;
  const heightAt = (x, z) => {
    const t = terrain ? terrain.heightAt(x, z) : 0;
    if (!outpost?.heightAt) return t;
    const h = outpost.heightAt(x, z);
    return Number.isFinite(h) ? Math.max(t, h) : t;
  };
  return {
    heightAt,
    normalAt(x, z, eps = 1.0) {
      return new THREE.Vector3(
        heightAt(x - eps, z) - heightAt(x + eps, z),
        2 * eps,
        heightAt(x, z - eps) - heightAt(x, z + eps),
      ).normalize();
    },
  };
}

export async function install(world) {
  const { engine } = world;
  const chars = world.registry?.characters;
  const player = chars?.player;
  if (!player) {
    console.warn('gameplay: no player character published; controller not installed');
    return null;
  }

  const gameState = resolveGameState(world);
  const outpost = world.registry?.outpost ?? null;
  const ground = resolveGround(world);
  const events = makeEvents();

  // --- collision field ------------------------------------------------------
  // Centred on the compound because that is the only place with structures; a
  // 260 m box at 1024 covers the platform, the approach ramp and the near
  // boulder field at 0.25 m per texel.
  const centre = new THREE.Vector3();
  if (outpost?.bounds) outpost.bounds.getCenter(centre);
  const roots = [outpost?.group, world.registry?.rocks?.group].filter(Boolean);
  const obstacles = roots.length
    ? new ObstacleField(engine.renderer, roots, {
        center: centre,
        extent: 260,
        res: 1024,
        padLevel: outpost?.padLevel ?? 0,
      })
    : null;

  // --- systems --------------------------------------------------------------
  const input = new Input(engine.renderer.domElement, {});
  const controller = new PlayerController({ character: player, ground, obstacles });
  const camera = new PlayerCamera(engine.camera, { obstacles, ground });
  const stealth = new StealthActions({
    controller,
    camera,
    characters: chars.characters ?? [player],
    obstacles,
    ground,
    coverPoints: outpost?.coverPoints ?? [],
    events,
  });

  // The pose the `gameplay` shot was framed against. Play mode borrows the
  // player; leaving it must hand him back byte-identical.
  const parked = {
    x: player.position.x,
    z: player.position.z,
    yaw: player.yaw,
    stance: player.anim.stance,
    aim: player.anim.aim,
    aimTarget: player.anim.aimTarget.clone(),
    lookTarget: player.anim.lookTarget ? player.anim.lookTarget.clone() : null,
    fov: engine.camera.fov,
    // The framing solver's heading is the CAMERA's, not the body's — the shot
    // stands the soldier 0.62 rad off it so the weapon side faces the lens.
    // Entering play mode with the camera on that heading reproduces the
    // canonical `gameplay` frame exactly, which is a free regression test.
    camYaw: chars.playerSpawn?.yaw ?? player.yaw,
  };

  let active = false;

  function enterPlay() {
    if (active) return;
    active = true;
    // Whatever lens the world was being viewed through is what it goes back to;
    // capturing it at install would hand the harness the Engine's 50 degree
    // default instead of the shot's own FOV.
    parked.fov = engine.camera.fov;
    player.controlled = true;
    controller.position.set(parked.x, ground.heightAt(parked.x, parked.z), parked.z);
    controller.footY = controller.position.y;
    controller.velocity.set(0, 0, 0);
    controller.yaw = parked.yaw;
    controller.stance = 'stand';
    controller.stanceTimer = 0;
    camera.reset(controller.position, parked.camYaw);
    input.enable();
    setFocus();
    events.emit({ type: 'modeEnter' });
  }

  function exitPlay() {
    if (!active) return;
    active = false;
    input.disable();
    // Let go of anyone being held or dragged. A guard left flagged `held` with
    // nothing driving him is a character the AI will never take back.
    if (stealth.grabbed) {
      stealth.grabbed.held = false;
      stealth.grabbed.controlled = false;
      stealth.grabbed = null;
    }
    stealth.dragging = null;
    stealth.inCover = false;
    stealth.isAiming = false;
    stealth.aimAmount = 0;
    stealth.action = 'none';
    stealth.actionTimer = 0;
    stealth.lean = 0;
    player.controlled = false;
    player.position.set(parked.x, 0, parked.z);
    player.yaw = parked.yaw;
    player.anim.stance = parked.stance;
    player.anim.speed = 0;
    player.anim.aim = parked.aim;
    player.anim.aimTarget.copy(parked.aimTarget);
    player.anim.lookTarget = parked.lookTarget ? parked.lookTarget.clone() : null;
    player.anim.action = 'none';
    player.anim.actionTime = 0;
    player.anim.inCover = false;
    player.anim.lean = 0;
    engine.camera.fov = parked.fov;
    engine.camera.updateProjectionMatrix();
    camera._fov = parked.fov;
    events.emit({ type: 'modeExit' });
  }

  /** Autofocus follows the shoulder: the subject, not the optical axis. */
  function setFocus() {
    const af = engine.pipeline?.afPoint;
    if (!af) return;
    af.set(camera.shoulder > 0 ? 0.32 : 0.68, 0.42);
  }

  gameState.onModeChange((mode) => {
    if (mode === 'play') enterPlay();
    else exitPlay();
  });
  if (gameState.mode === 'play') enterPlay();

  // Losing pointer lock is the player hitting Escape. Hand the frame back to
  // whoever owns the front end rather than leaving a locked-out camera.
  input.onLockChange((locked) => {
    if (!locked && active) events.emit({ type: 'lockLost' });
  });

  // --- stance ---------------------------------------------------------------
  function updateStance(aiming) {
    if (input.pressed('prone')) {
      controller.setStance(controller.stance === 'prone' ? 'crouch' : 'prone');
    } else if (input.pressed('crouch')) {
      controller.setStance(controller.stance === 'crouch' ? 'stand' : 'crouch');
    } else if (!aiming && input.down('sprint') && controller.stance !== 'stand' && input.moveMag > 0.6) {
      // Breaking into a run stands you up; you do not sprint on your elbows.
      controller.standUp();
    }
  }

  // --- per-frame ------------------------------------------------------------
  // Order 15: before src/characters ticks its animators at 20, so the pose the
  // animator solves is this frame's position and not last frame's.
  engine.addSystem({
    order: 15,
    update(dt) {
      if (!active) return;
      input.update(dt);
      if (input.pressed('swapShoulder')) {
        camera.swapShoulder();
        setFocus();
      }
      // Sprint and hold-breath deliberately share a key. Stance must therefore
      // ask whether the weapon is up before it reads that key as "get up".
      updateStance(stealth.isAiming);

      // Look BEFORE the verbs: the aim ray is built from camera.yaw/pitch, so
      // applying this frame's stick first is what keeps the reticle off a
      // one-frame delay.
      camera.addLook(input.look.x, input.look.y);
      const cmd = stealth.update(dt, input, camera.yaw);

      controller.update(dt, {
        moveX: input.move.x,
        moveY: input.move.y,
        camYaw: camera.yaw,
        walk: input.down('walk'),
        sprint: input.down('sprint'),
        aiming: cmd.aiming,
        faceYaw: cmd.faceYaw,
        lockAxis: cmd.lockAxis,
        frozen: cmd.frozen,
        maxSpeed: cmd.maxSpeed,
        // Peeking slides the body out from behind cover as well as the camera;
        // a lean that only moves the lens shoots through the wall.
        lean: stealth.inCover ? stealth.lean : 0,
      });
    },
  });

  // Order 1100: after the animator (20) has seated the root and after the
  // free-fly system (1000), which no-ops outside godmode.
  engine.addSystem({
    order: 1100,
    update(dt) {
      if (!active) return;
      camera.update(dt, {
        position: controller.position,
        velocity: controller.velocity,
        aiming: stealth.isAiming,
        stance: controller.stance,
        sprint: controller.sprinting,
      });
    },
  });

  // --- published API --------------------------------------------------------
  const api = {
    player,
    input,
    controller,
    camera,
    stealth,
    obstacles,
    events,
    ANIM_CHANNELS,

    get active() {
      return active;
    },
    /** 'stand' | 'crouch' | 'prone' */
    get stance() {
      return controller.stance;
    },
    get isAiming() {
      return stealth.isAiming;
    },
    get position() {
      return controller.position;
    },
    get velocity() {
      return controller.velocity;
    },
    get speed() {
      return controller.speed;
    },
    get sprinting() {
      return controller.sprinting;
    },
    /** 0..1. Sprinting is loud, prone is silent. */
    get noiseLevel() {
      return active ? controller.noise : 0;
    },
    /** The same signal as a hearing radius in metres, which is what senses want. */
    get noiseRadius() {
      return active ? controller.noiseRadius : 0;
    },
    get inCover() {
      return stealth.inCover;
    },
    get holdingBreath() {
      return !!stealth.holdingBreath;
    },
    get breath() {
      return stealth.breath;
    },
    get ammo() {
      return stealth.ammo;
    },
    get reloading() {
      return stealth.reloading > 0;
    },
    /** World point the weapon is pointed at, sway included. */
    get aimPoint() {
      return stealth.aimPoint;
    },
    /** The character the player would CQC right now, or null. Drives the prompt. */
    get cqcTarget() {
      const t = stealth.nearestTarget();
      return t && stealth.isBehind(t) ? t : null;
    },
    get carrying() {
      return stealth.dragging;
    },
    get grabbed() {
      return stealth.grabbed;
    },

    fire: () => stealth.fire(),
    cqc: () => stealth.cqc(),
    stow: () => stealth.stowBody(),
    setStance: (s) => controller.setStance(s),
    /** Rebind at runtime: api.rebind('crouch', ['KeyX', 'Pad1']) */
    rebind: (action, sources) => input.rebind(action, sources),
    bindings: input.bindings,
  };

  world.registry.player = api;
  return api;
}
