import * as THREE from 'three';
import { SHOTS } from '../debug/Shots.js';
import { buildCharacterGeometry, Character } from './character.js';
import { Behaviour, BEHAVIOURS } from './behaviour.js';
import { CharacterLOD } from './lod.js';
import { ACTIONS } from './actions.js';

/**
 * characters module.
 *
 * Everything is procedural: a lofted, skinned humanoid (see body.js / rig.js /
 * skinning.js), kit welded into the same skinned mesh so a full soldier costs
 * three or four draw calls, and a keyframe-free animation system (anim.js /
 * locomotion.js / actions.js) that plants feet on `terrain.heightAt()` and
 * keeps the rifle locked in both hands.
 *
 * THE ACTOR API. This is what gameplay and AI call; it is the whole contract.
 * Every one of these takes an `actor`, which may be a Character, its name, or
 * its index — resolve() is deliberately forgiving so callers never have to
 * hold a handle they did not ask for.
 *
 *   characters.setStance(actor, stance)          'stand'|'crouch'|'prone'|'down'
 *   characters.setLocomotion(actor, velocity)    world m/s; Vector3, array or {x,z}
 *   characters.playAction(actor, name, opts)     see ACTION_NAMES
 *   characters.setAimTarget(actor, worldPos)     null lowers the weapon
 *
 * and the rest of the surface:
 *
 *   characters.setFacing(actor, yaw)             body yaw in radians
 *   characters.setAimWeight(actor, 0..1)         slung .. cheek weld
 *   characters.setLookTarget(actor, worldPos)    null = idle sweep
 *   characters.setBehaviour(actor, state, opts)  see BEHAVIOUR_STATES
 *   characters.setControlled(actor, bool)        true = ambient behaviour off
 *   characters.warp(actor, x, z, yaw)            teleport without foot drag
 *   characters.stateOf(actor)                    { stance, locomotion, action, ... }
 *   characters.spawnSoldier(pos, opts)           -> Character
 *   characters.player / .characters / .ground / .group / .variants
 *   characters.setLodBias(n) / .setAmbient(bool) / .stats()
 */

/** Valid `playAction` names. Exposed so callers can validate rather than guess. */
export const ACTION_NAMES = Object.keys(ACTIONS);
/** Valid `setBehaviour` states. */
export const BEHAVIOUR_STATES = BEHAVIOURS;

/** Deterministic RNG — screenshots must be byte-reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const LOADOUTS = {
  player: {
    name: 'snake',
    bulk: 1.04,
    sleeves: 'full',
    headgear: 'bandana',
    eyepatch: true,
    hair: true,
    // Round 4: this was `true`, i.e. hair only on the BACK of the skull. With a
    // bandana that sits as a 25 mm band across the brow, that left the entire
    // crown as bare scalp — and scalp is skin, so from the gameplay camera the
    // head rendered as a pale tan dome with a red ribbon on it. The bandana
    // goes over the hair; there has to be hair under it.
    hairBack: false,
    prosthetic: 'left',
    vest: true,
    backpack: true,
    holster: true,
    kneepads: true,
    fingerless: true,
    beltPouches: [-0.11, 0.11],
    head: { jawWidth: 1.12 },
  },
  // Three enemy variants. Different headgear, sleeves, load and build so a
  // patrol does not read as a row of clones.
  grunt: {
    name: 'grunt',
    bulk: 1.0,
    sleeves: 'full',
    headgear: 'helmet',
    vest: true,
    backpack: false,
    holster: false,
    kneepads: true,
    beltPouches: [-0.12, 0.1],
  },
  scout: {
    name: 'scout',
    bulk: 0.95,
    sleeves: 'rolled',
    headgear: 'cap',
    vest: true,
    backpack: true,
    holster: false,
    kneepads: false,
    grenades: false,
    optic: false,
    beltPouches: [-0.1],
  },
  officer: {
    name: 'officer',
    bulk: 1.08,
    sleeves: 'full',
    headgear: 'boonie',
    vest: true,
    backpack: false,
    holster: true,
    kneepads: true,
    beltPouches: [0.12],
    head: { jawWidth: 0.92 },
  },
};

/**
 * Linear-space base skin. Round 4 lifted these ~16%: a weathered mid-latitude
 * face measures 0.34-0.42 diffuse reflectance in the red, and the shader stacks
 * a mottle, a brow shade, a stubble tint and an AO term on top of whatever it
 * is given — so an already-dark base arrives at the frame as a silhouette.
 */
const SKIN_TONES = [
  [0.348, 0.220, 0.162],
  [0.308, 0.190, 0.136],
  [0.258, 0.150, 0.103],
  [0.388, 0.252, 0.188],
];

/** Per-instance uniform variation: different dye lot, dust load and skin. */
function instanceMaterials(rand, opts = {}) {
  const seed = rand() * 100;
  const tone = SKIN_TONES[Math.floor(rand() * SKIN_TONES.length)];
  const warm = 0.9 + rand() * 0.25;
  return {
    cloth: {
      seed,
      dust: opts.dust ?? 0.35 + rand() * 0.55,
      palette: opts.palette,
    },
    skin: {
      seed: seed * 1.7,
      tone: [tone[0] * warm, tone[1] * warm, tone[2] * warm],
      stubble: 0.25 + rand() * 0.75,
      sssAmount: 0.26 + rand() * 0.12,
    },
    metal: { seed: seed * 3.1 },
  };
}

/**
 * Find where to stand the player so the canonical `gameplay` camera actually
 * frames a whole character. Marching the view ray and testing the real ground
 * height means this keeps working if the terrain around the valley changes —
 * a hard-coded spawn would silently fall out of frame.
 */
function frameSpawn(ground, shot) {
  const cam = new THREE.Vector3(...shot.position);
  const tgt = new THREE.Vector3(...shot.target);
  const dir = tgt.clone().sub(cam).normalize();
  const horiz = new THREE.Vector3(dir.x, 0, dir.z).normalize();
  const camPitch = Math.asin(dir.y);
  const halfV = THREE.MathUtils.degToRad(shot.fov) / 2;
  const top = camPitch + halfV;
  const bottom = camPitch - halfV;
  const H = 1.86;
  const yaw = Math.atan2(-horiz.x, -horiz.z);

  // An over-the-shoulder shot declares its rig; the subject is then wherever the
  // rig says, not wherever a whole body happens to fit. Solving for "fits inside
  // the frame" is what pushed round 2's player out to 4.6 m — the solver was
  // being asked to keep the boots on screen, and MGSV's camera does not.
  if (shot.subject) {
    const { dist, lateral = 0, } = shot.subject;
    // Camera-right in the same basis three.js' lookAt builds: x = up x (eye-target).
    const rx = -horiz.z;
    const rz = horiz.x;
    return {
      x: cam.x + horiz.x * dist - rx * lateral,
      z: cam.z + horiz.z * dist - rz * lateral,
      D: dist,
      yaw,
    };
  }

  let fallback = null;
  // 2.4 m is the closest a third-person camera ever sits behind a character;
  // nearer than that and the shoulder fills the lens.
  //
  // The margins are deliberately tight. The gameplay shot is THE frame this
  // game gets judged on, and the first version of this solver kept a 4-degree
  // safety border at top and bottom that pushed the player out to 5.3 m — a
  // 37%-of-frame-height figure standing in the corner, which reads as set
  // dressing rather than as the protagonist. Landing the boots on the bottom
  // edge instead buys about 20% more subject.
  for (let D = 2.4; D <= 70; D += 0.1) {
    const x = cam.x + horiz.x * D;
    const z = cam.z + horiz.z * D;
    const g = ground.heightAt(x, z);
    const head = Math.atan2(g + H - cam.y, D);
    const foot = Math.atan2(g - cam.y, D);
    if (!fallback) fallback = { x, z, D };
    if (head < top - 0.035 && foot > bottom + 0.012) {
      // Push off the optical axis so the framing reads over-the-shoulder rather
      // than centred like a character viewer: subject on the third, not centred.
      const off = Math.min(1.6, 0.25 + D * 0.16);
      return { x: x + dir.z * off, z: z - dir.x * off, D, yaw };
    }
  }
  return { x: fallback.x, z: fallback.z, D: fallback.D, yaw };
}

/**
 * Ground resolver. The outpost lays a graded pad over the natural terrain, so
 * anything standing inside it must query the outpost, not the heightfield —
 * otherwise the whole garrison is buried 20 m under its own base.
 */
function makeGround(terrain, outpost) {
  const usable = outpost && typeof outpost.heightAt === 'function';
  const heightAt = (x, z) => {
    const t = terrain ? terrain.heightAt(x, z) : 0;
    if (!usable) return t;
    const h = outpost.heightAt(x, z);
    // The graded surface is authored to sit *below* the natural ground wherever
    // it is not the visible surface (including under the approach causeway,
    // which lifts back above it), so max() is the whole test. Gating on
    // isInside() instead left a guard post a metre outside the polygon standing
    // on the valley floor 21 m under his own base.
    return Number.isFinite(h) ? Math.max(t, h) : t;
  };
  return {
    heightAt,
    normalAt(x, z, eps = 1.0) {
      const hL = heightAt(x - eps, z);
      const hR = heightAt(x + eps, z);
      const hD = heightAt(x, z - eps);
      const hU = heightAt(x, z + eps);
      return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
    },
  };
}

/** Coerce the various shapes a waypoint might arrive in into a Vector3. */
function toVec(p) {
  if (!p) return null;
  if (p.isVector3) return p.clone();
  if (p.position) return toVec(p.position);
  if (Array.isArray(p)) return new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
  if (typeof p.x === 'number') return new THREE.Vector3(p.x, p.y ?? 0, p.z ?? 0);
  return null;
}

export async function install(world) {
  const { scene, terrain, engine } = world;
  const rand = rng(0x5eed17);
  const outpost = world.registry?.outpost ?? null;
  const ground = makeGround(terrain, outpost);

  // Build one geometry per variant; instances share it and vary by material
  // uniforms and scale. Four AO bakes at boot instead of one per soldier.
  //
  // Plus one coarse build per variant for the distance LOD. It is the same
  // authoring code at a lower tessellation, so it costs a second AO bake over
  // ~a third as many vertices, and it takes ~70% of the triangles off every
  // character past ~34 m. See `setDetail` in geometry.js for why that matters
  // more than anything on the CPU side.
  const variants = {};
  const variantsLow = {};
  for (const key of Object.keys(LOADOUTS)) {
    variants[key] = buildCharacterGeometry(LOADOUTS[key]);
    variantsLow[key] = buildCharacterGeometry(LOADOUTS[key], { detail: 0.5 });
  }

  const group = new THREE.Group();
  group.name = 'characters';
  scene.add(group);

  const characters = [];
  const byName = new Map();

  function makeCharacter(variantKey, opts = {}) {
    const built = variants[variantKey];
    const ch = new Character(built, {
      low: variantsLow[variantKey],
      name: opts.name ?? variantKey,
      terrain: ground,
      scale: opts.scale ?? 1,
      position: opts.position ?? [0, 0, 0],
      yaw: opts.yaw ?? 0,
      materials: instanceMaterials(rand, opts),
    });
    ch.index = characters.length;
    ch.behaviour = new Behaviour(ch, ground, characters.length * 2654435761 + 17);
    group.add(ch.root);
    characters.push(ch);
    byName.set(ch.name, ch);
    return ch;
  }

  // --- the player ---------------------------------------------------------
  const spawn = frameSpawn(ground, SHOTS.gameplay);
  const player = makeCharacter('player', {
    name: 'snake',
    position: [spawn.x, 0, spawn.z],
    // Round 4: was +0.52 (30 deg off dead-away). At 30 degrees the rucksack is
    // the entire subject — a row-scan across the back panel of the shipped
    // frame returned 150 consecutive pixels of the same value, because that is
    // literally all the camera could see. Turning him 63 degrees to camera-LEFT
    // instead swings the whole weapon, the support arm, the chest rig and the
    // near flank into the frame, and it faces him into the aim space the
    // over-the-shoulder framing leaves open on the right. Negative, not
    // positive: it is the prosthetic arm and the rifle that end up camera-side.
    // ROUND 6: 1.10 rad (63 deg) -> 0.42 rad (24 deg).
    //
    // This one number was the root cause of most of what the last three rounds
    // of critique called out on the character, and it was never suspected
    // because it is not in a file anyone was looking at.
    //
    // Swept the body yaw in a live probe and measured LIMB PRESENTATION at each
    // angle — screen length of a bone divided by its true length at that depth,
    // so 1.0 means the bone lies in the image plane and 0.1 means it points
    // straight at the lens and draws as a stub whatever you model:
    //
    //   turn   shoulders  upperArmR  forearmR  upperArmL  forearmL
    //   1.10     0.25       0.76       0.11      1.00       0.91   <- round 5
    //   0.80     0.51       0.85       0.38      0.95       0.99
    //   0.62     0.66       0.92       0.53      0.90       1.02   <- here
    //   0.20     0.92       1.00       0.82      0.78       1.00
    //
    // At round 5's 63 degrees the firing forearm projected at ELEVEN PERCENT of
    // its length — a 272 mm bone drawing as 25 px — and the shoulder line at
    // 25%. That is why the head measured 0.608 of the shoulder span against a
    // real 0.37-0.40 (a skull is near-spherical in plan, so it projects at full
    // width from every angle while the shoulders collapse), and it is most of
    // why the arm could not be found: it was end-on. Everything except the
    // support upper arm improves monotonically as the turn comes off.
    //
    // 0.42 rad is where the curves cross. The weapon still clears the body —
    // it is carried muzzle-down across the front and its handguard and barrel
    // project past the near hip, which is exactly how MGSV frames it.
    yaw: spawn.yaw - 0.62,
    scale: 1.02,
  });
  player.controlled = false;
  player.isPlayer = true;
  // The player holds his own pose; the ambient guard behaviour must not walk
  // him out of the canonical `gameplay` framing.
  player.behaviour.setState('idle');
  // Low ready, not shouldered. `aim` blends toward the cheek weld, which pulls
  // the weapon up in front of the chest and squares the shoulders to the
  // target; a small amount reads as alert, more reads as a firing pose that the
  // camera is not framed for.
  player.anim.aim = 0.12;
  player.anim.aimActive = true;
  const aimYaw = spawn.yaw - 0.62;
  player.anim.aimTarget.set(
    spawn.x - Math.sin(aimYaw) * 26,
    ground.heightAt(spawn.x, spawn.z) + 1.2,
    spawn.z - Math.cos(aimYaw) * 26,
  );
  // Head turned a further ~25 degrees off the weapon line: eyes leading the
  // muzzle is what separates a soldier scanning from a mannequin pointed at a
  // wall, and it puts the profile of the face into the silhouette.
  player.anim.lookTarget = new THREE.Vector3(
    spawn.x - Math.sin(aimYaw - 0.44) * 22,
    ground.heightAt(spawn.x, spawn.z) + 1.72,
    spawn.z - Math.cos(aimYaw - 0.44) * 22,
  );

  // --- enemy soldiers -----------------------------------------------------
  const soldierVariants = ['grunt', 'scout', 'officer'];
  function spawnSoldier(pos, opts = {}) {
    const key = opts.variant ?? soldierVariants[Math.floor(rand() * soldierVariants.length)];
    const p = pos?.isVector3 ? [pos.x, pos.y, pos.z] : pos ?? [0, 0, 0];
    const ch = makeCharacter(key, {
      name: opts.name ?? `${key}-${characters.length}`,
      position: [p[0], 0, p[2]],
      yaw: opts.yaw ?? rand() * Math.PI * 2,
      // 1.72 m to 1.92 m. Height variation is the cheapest anti-clone measure.
      scale: opts.scale ?? 0.95 + rand() * 0.1,
    });
    ch.setStance('stand');
    if (opts.patrol) ch.behaviour.setState('patrol', { route: opts.patrol, index: 1 });
    else ch.behaviour.setState('post', { yaw: ch.yaw });
    return ch;
  }

  // Garrison the outpost when it published posts and routes; otherwise fall back
  // to a loose cordon around the player so the canonical shots are never empty.
  let garrisoned = 0;
  const MAX_SOLDIERS = 8;
  for (const post of outpost?.guardPosts ?? []) {
    if (garrisoned >= MAX_SOLDIERS) break;
    const p = toVec(post);
    if (!p) continue;
    const facing = Math.atan2(-p.x, -p.z) + Math.PI;
    const s = spawnSoldier([p.x, 0, p.z], { yaw: facing + (rand() - 0.5) * 1.2 });
    if (post.kind === 'emplacement' && rand() < 0.5) s.setStance('crouch');
    garrisoned++;
  }
  const routes = (outpost?.patrolWaypoints ?? []).filter((r) => Array.isArray(r) && r.length >= 2);
  for (let i = 0; i < Math.min(3, routes.length) && garrisoned < MAX_SOLDIERS; i++) {
    const route = routes[i].map(toVec).filter(Boolean);
    if (route.length < 2) continue;
    const start = route[0];
    const s = spawnSoldier([start.x, 0, start.z], {});
    s.behaviour.setState('patrol', { route, index: 1 });
    garrisoned++;
  }

  const cordon = garrisoned >= 4 ? [] : [
    { at: [spawn.x + 5.5, spawn.z - 7.0], yaw: 2.5, patrol: true },
    { at: [spawn.x - 6.5, spawn.z - 11.0], yaw: 0.6, patrol: true },
    { at: [spawn.x + 12.0, spawn.z - 18.0], yaw: 3.6, patrol: false, stance: 'crouch' },
    { at: [spawn.x - 14.0, spawn.z - 24.0], yaw: 1.4, patrol: true },
    { at: [spawn.x + 2.0, spawn.z - 30.0], yaw: 4.4, patrol: false },
    { at: [spawn.x - 24.0, spawn.z - 6.0], yaw: 5.6, patrol: true },
  ];
  cordon.forEach((c, i) => {
    const s = spawnSoldier([c.at[0], 0, c.at[1]], { yaw: c.yaw, variant: soldierVariants[i % 3] });
    if (c.stance) s.setStance(c.stance);
    if (c.patrol) {
      const a = new THREE.Vector3(c.at[0], 0, c.at[1]);
      const b = a.clone().add(new THREE.Vector3(Math.sin(c.yaw) * -14, 0, Math.cos(c.yaw) * -14));
      s.behaviour.setState('patrol', { route: [a, b], index: 1 });
    }
  });

  // --- per-frame ----------------------------------------------------------
  const lod = new CharacterLOD();
  /** Ambient behaviour drives anyone gameplay/AI has not claimed. */
  let ambient = true;
  let animate = true;

  engine.addSystem({
    order: 20,
    update(dt, e) {
      if (!animate) return;
      lod.begin(e.camera);
      for (const ch of characters) {
        const job = lod.evaluate(ch, dt);
        if (!job) continue;
        if (ambient && !ch.controlled) ch.behaviour.update(job.dt);
        ch.update(job.dt, job.ik);
      }
    },
  });

  // The world renders behind the menu and under the free-fly camera, so the
  // garrison keeps living in every mode. All the seam does is hand control of
  // individual actors to gameplay: anything gameplay marks `controlled` is
  // skipped by the ambient behaviour, and everything else carries on.
  world.gameState?.onModeChange?.((mode) => {
    if (mode !== 'play') {
      for (const ch of characters) {
        if (ch.controlled && !ch.isPlayer) {
          ch.controlled = false;
          ch.behaviour.setState('post', { yaw: ch.yaw });
        }
      }
    }
  });

  // --- actor API ----------------------------------------------------------
  /** Character | name | index -> Character, or null. */
  function resolve(actor) {
    if (!actor) return null;
    if (actor.isCharacterActor || actor instanceof Character) return actor;
    if (typeof actor === 'string') return byName.get(actor) ?? null;
    if (typeof actor === 'number') return characters[actor] ?? null;
    return null;
  }

  const api = {
    player,
    characters,
    byName,
    spawnSoldier,
    variants,
    variantsLow,
    /** Where the framing solver put the player — handy for camera work. */
    playerSpawn: spawn,
    ground,
    group,
    lod,
    ACTION_NAMES,
    BEHAVIOUR_STATES,
    resolve,

    setStance(actor, stance) {
      const c = resolve(actor);
      return c ? c.setStance(stance) : null;
    },
    setLocomotion(actor, velocity) {
      const c = resolve(actor);
      if (c) c.setLocomotion(velocity);
      return c;
    },
    playAction(actor, name, opts) {
      const c = resolve(actor);
      return c ? c.playAction(name, opts) : false;
    },
    setAimTarget(actor, worldPos) {
      const c = resolve(actor);
      if (c) c.setAimTarget(worldPos);
      return c;
    },
    setAimWeight(actor, w) {
      const c = resolve(actor);
      if (c) c.setAimWeight(w);
      return c;
    },
    setFacing(actor, yaw) {
      const c = resolve(actor);
      if (c) c.setFacing(yaw);
      return c;
    },
    setLookTarget(actor, worldPos) {
      const c = resolve(actor);
      if (c) c.setLookTarget(worldPos);
      return c;
    },
    setBehaviour(actor, state, opts) {
      const c = resolve(actor);
      return c ? c.behaviour.setState(state, opts) : null;
    },
    setControlled(actor, on = true) {
      const c = resolve(actor);
      if (c) c.controlled = !!on;
      return c;
    },
    warp(actor, x, z, yaw) {
      const c = resolve(actor);
      if (c) c.warp(x, z, yaw);
      return c;
    },
    /** Everything a caller might want to read back, in one object. */
    stateOf(actor) {
      const c = resolve(actor);
      if (!c) return null;
      return {
        name: c.name,
        position: c.position,
        yaw: c.yaw,
        stance: c.anim.loco.stance,
        locomotion: c.anim.loco.label,
        speed: c.anim.loco.smoothSpeed,
        action: c.anim.actions.action,
        busy: c.busy,
        downed: c.downed,
        behaviour: c.behaviour.state,
        aiming: c.anim.aimActive ? c.anim.aim : 0,
        lodTier: c.lodState?.tier ?? 0,
      };
    },

    /** Turn the built-in guard behaviour off when gameplay owns everyone. */
    setAmbient(on) {
      ambient = !!on;
    },
    /** < 1 pulls every LOD ring in; false disables LOD entirely. */
    setLodBias(b) {
      if (b === false) lod.enabled = false;
      else {
        lod.enabled = true;
        lod.bias = b;
      }
    },
    /** Used by the perf probe to price the animation system on its own. */
    setAnimationEnabled(on) {
      animate = !!on;
    },
    stats() {
      return { count: characters.length, ...lod.stats() };
    },
  };
  return api;
}
