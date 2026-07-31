import * as THREE from 'three';
import { SHOTS } from '../debug/Shots.js';
import { buildCharacterGeometry, Character } from './character.js';

/**
 * characters module.
 *
 * Publishes { player, characters, spawnSoldier(pos), variants } so the
 * gameplay/AI module can take over driving anyone it likes. Any character with
 * `controlled = true` is left alone by the idle patrol behaviour in here.
 *
 * Everything is procedural: a lofted, skinned humanoid (see body.js / rig.js /
 * skinning.js), kit welded into the same skinned mesh so a full soldier costs
 * three draw calls, and a keyframe-free animation system (anim.js) that plants
 * feet on terrain.heightAt() and keeps the rifle locked in both hands.
 */

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
    hairBack: true,
    prosthetic: 'left',
    vest: true,
    backpack: true,
    holster: true,
    kneepads: false,
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

const SKIN_TONES = [
  [0.30, 0.188, 0.138],
  [0.265, 0.162, 0.116],
  [0.222, 0.128, 0.088],
  [0.335, 0.215, 0.16],
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
      sssAmount: 0.18 + rand() * 0.1,
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
  let fallback = null;
  // 2.8 m is the closest a third-person camera ever sits behind a character;
  // nearer than that and the shoulder fills the lens.
  for (let D = 2.8; D <= 70; D += 0.2) {
    const x = cam.x + horiz.x * D;
    const z = cam.z + horiz.z * D;
    const g = ground.heightAt(x, z);
    const head = Math.atan2(g + H - cam.y, D);
    const foot = Math.atan2(g - cam.y, D);
    if (!fallback) fallback = { x, z, D };
    if (head < top - 0.07 && foot > bottom + 0.05) {
      // Push off the optical axis so the framing reads over-the-shoulder rather
      // than centred like a character viewer.
      // Classic over-the-shoulder: subject on the third, not centred.
      const off = Math.min(2.0, 0.3 + D * 0.2);
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
  const variants = {};
  for (const key of Object.keys(LOADOUTS)) variants[key] = buildCharacterGeometry(LOADOUTS[key]);

  const group = new THREE.Group();
  group.name = 'characters';
  scene.add(group);

  const characters = [];

  function makeCharacter(variantKey, opts = {}) {
    const built = variants[variantKey];
    const ch = new Character(built, {
      name: opts.name ?? variantKey,
      terrain: ground,
      scale: opts.scale ?? 1,
      position: opts.position ?? [0, 0, 0],
      yaw: opts.yaw ?? 0,
      materials: instanceMaterials(rand, opts),
    });
    group.add(ch.root);
    characters.push(ch);
    return ch;
  }

  // --- the player ---------------------------------------------------------
  const spawn = frameSpawn(ground, SHOTS.gameplay);
  const player = makeCharacter('player', {
    name: 'snake',
    position: [spawn.x, 0, spawn.z],
    yaw: spawn.yaw - 0.22,
    scale: 1.02,
  });
  player.controlled = false;
  player.isPlayer = true;
  // Weapon part-way up: an alert ready stance reads with far more intent than a
  // neutral idle, and it is the pose the third-person camera is framed around.
  player.anim.aim = 0.42;
  player.anim.aimTarget.set(
    spawn.x - Math.sin(spawn.yaw) * 26,
    ground.heightAt(spawn.x, spawn.z) + 1.5,
    spawn.z - Math.cos(spawn.yaw) * 26,
  );
  player.anim.lookTarget = new THREE.Vector3(spawn.x - 16, ground.heightAt(spawn.x - 16, spawn.z - 26) + 1.7, spawn.z - 26);

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
    ch.stance = 'stand';
    ch.patrol = opts.patrol ?? null;
    ch.patrolIndex = 0;
    ch.waitTimer = rand() * 4;
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
    s.patrol = route;
    s.patrolIndex = 1;
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
      s.patrol = [a, b];
    }
  });

  // --- per-frame ----------------------------------------------------------
  const _v = new THREE.Vector3();
  engine.addSystem({
    order: 20,
    update(dt) {
      for (const ch of characters) {
        if (!ch.controlled) idleBehaviour(ch, dt, _v);
        ch.update(dt);
      }
    },
  });

  /** Minimal stand-in behaviour so nobody is a statue until AI takes over. */
  function idleBehaviour(ch, dt, tmp) {
    if (ch.isPlayer) {
      ch.drive(dt, 0, ch.yaw);
      return;
    }
    if (!ch.patrol) {
      ch.drive(dt, 0, ch.yaw);
      return;
    }
    const target = ch.patrol[ch.patrolIndex % ch.patrol.length];
    tmp.set(target.x - ch.position.x, 0, target.z - ch.position.z);
    const d = tmp.length();
    if (d < 1.0) {
      ch.waitTimer -= dt;
      ch.drive(dt, 0, ch.yaw);
      if (ch.waitTimer <= 0) {
        ch.patrolIndex++;
        ch.waitTimer = 2 + ((ch.patrolIndex * 37) % 5);
      }
      return;
    }
    ch.drive(dt, 1.35, Math.atan2(-tmp.x, -tmp.z));
  }

  return {
    player,
    characters,
    spawnSoldier,
    variants,
    /** Where the framing solver put the player — handy for camera work. */
    playerSpawn: spawn,
    ground,
    group,
  };
}
