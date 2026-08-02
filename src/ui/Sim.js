/**
 * Sim.js — a stand-in feed for the HUD, OFF BY DEFAULT.
 *
 * `src/gameplay` and `src/ai` are still 17-line stubs, so in a normal build the
 * HUD correctly draws almost nothing: no weapon is published, so no weapon block
 * is shown, and no sensors are published, so no detection markers exist. That is
 * the right behaviour — a HUD full of invented numbers is worse than no HUD —
 * but it also makes the work unreviewable.
 *
 * So this exists, behind `?uidemo=1` or `window.__UI.demo(true)`, and it never
 * turns itself on. It does NOT fabricate the world: the sensors it reports are
 * the real guards `src/characters` placed, at their real positions, with an
 * awareness derived from real distance and real facing. Only the loadout is
 * invented, and only because a magazine count has no world state to read.
 *
 * The instant `registry.ai` / `registry.gameplay` publish anything, the UI reads
 * those instead — this is a separate registry view handed to the adapter, not a
 * write into the shared registry, so nothing else in the game can see it.
 */

import * as THREE from 'three';

const SIGHT = 52; // metres a guard can plausibly notice someone at
const CONE = Math.cos(THREE.MathUtils.degToRad(52)); // half-angle of the vision cone

export class Sim {
  constructor(world) {
    this.world = world;
    this.enabled = false;

    this._guards = [];
    this._aware = new Map();
    this._seenFor = 0;
    this._fwd = new THREE.Vector3();

    this._fireT = 0;
    this.gameplay = {
      player: {
        position: world.engine.camera.position,
        health: 1,
        stance: 'crouch',
        // The AGREED weapon descriptor, in full, so `?uidemo=1` exercises every
        // branch of the plate: comb, chip, suppressor row, reserve, reload.
        weapon: {
          name: 'WU S.PISTOL',
          kind: 'tranq',
          ammo: 6,
          magSize: 6,
          reserve: 42,
          mode: 'SEMI',
          suppressed: true,
          reloading: false,
        },
      },
    };
    this.ai = { alert: 'calm', sensors: [] };
  }

  /** The registry-shaped view handed to the adapter while demo mode is on. */
  view() {
    return { ai: this.ai, gameplay: this.gameplay };
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.ai.sensors.length = 0;
      this.ai.alert = 'calm';
    }
  }

  _collect() {
    const chars = this.world.registry.characters;
    if (!chars) return;
    const player = chars.player;
    this._guards = (chars.characters ?? []).filter((c) => c && c !== player && c.root);
  }

  update(dt) {
    if (!this.enabled) return;
    if (!this._guards.length) this._collect();

    const cam = this.world.engine.camera;
    const out = this.ai.sensors;
    out.length = 0;
    let peak = 0;

    for (let i = 0; i < this._guards.length; i++) {
      const g = this._guards[i];
      const gp = g.root.position;
      const dx = cam.position.x - gp.x;
      const dz = cam.position.z - gp.z;
      const d = Math.hypot(dx, dz);
      if (d > SIGHT) {
        this._aware.delete(i);
        continue;
      }
      // The guard's own facing, from its root yaw; -Z is forward.
      const yaw = g.root.rotation.y;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const dot = (dx * fx + dz * fz) / (d || 1);
      const inCone = dot > CONE;
      // Closing rate on certainty: near and dead ahead fills in about a second.
      const gain = inCone ? (1 - d / SIGHT) * (0.35 + dot * 1.5) : -0.55;
      const prev = this._aware.get(i) ?? 0;
      const next = Math.max(0, Math.min(1, prev + gain * dt));
      if (next <= 0.001) {
        this._aware.delete(i);
        continue;
      }
      this._aware.set(i, next);
      peak = Math.max(peak, next);
      out.push({
        id: g.name ? `${g.name}-${i}` : i,
        position: gp,
        awareness: next,
        // The real AI publishes these; the stand-in reports the same shape so
        // the marker's range, reason tag and urgency pulse are all reviewable.
        vis: { visible: inCone, rate: Math.max(0, gain), dist: d },
        state: next >= 0.999 ? 'combat' : inCone ? 'hold' : 'investigate',
      });
    }

    this.ai.alert = peak >= 0.999 ? 'alert' : peak > 0.5 ? 'caution' : peak > 0 ? 'evasion' : 'calm';

    // Damage feedback needs something to react to: sustained full detection
    // costs health, and it recovers when nobody has eyes on you.
    this._seenFor = peak >= 0.999 ? this._seenFor + dt : 0;
    const p = this.gameplay.player;
    p.health = Math.max(0.15, Math.min(1, p.health + (this._seenFor > 1.2 ? -0.09 : 0.16) * dt));

    // And the magazine has to move, or the comb and the reload sweep are
    // untestable. Under fire it empties; out of contact it reloads.
    const w = p.weapon;
    this._fireT += dt;
    if (w.reloading) {
      if (this._fireT > 2.1) {
        w.reloading = false;
        w.ammo = w.magSize;
        w.reserve = Math.max(0, w.reserve - w.magSize);
        this._fireT = 0;
      }
    } else if (this._seenFor > 0.4 && this._fireT > 0.42) {
      this._fireT = 0;
      if (w.ammo > 0) w.ammo--;
      else if (w.reserve > 0) w.reloading = true;
    }
  }
}
