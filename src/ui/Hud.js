/**
 * Hud.js — the in-play readout. Present only in 'play'.
 *
 * MGSV's HUD is mostly invisible. In a calm state the compass sits at a third
 * of its opacity, the alert block is not drawn at all, and the weapon block
 * decays to a whisper a few seconds after the last event. Everything here is
 * built to be looked at only when it has something to say:
 *
 *   ALERT STATE   the one element that must be unmissable. It CUTS in — no
 *                 fade, a two-step strobe on the word and an instant recolour
 *                 of the viewfinder frame — and only fades on the way back to
 *                 calm. It also fires a sound cue through `cue()`.
 *   DETECTION     one marker per sensor, on a ring around screen centre, at the
 *                 real bearing to that sensor, with a meter that fills as its
 *                 awareness climbs. Direction is the information; the marker is
 *                 the only thing on screen that tells you where to look.
 *   COMPASS       a scrolling degree ribbon with the objective pinned at its
 *                 true bearing.
 *   WEAPON        name, magazine/reserve in monospace, fire mode, stance glyphs.
 *   DAMAGE        an edge-only red bloom. No health bar — MGSV does not have
 *                 one and a bar would be the single least diegetic thing here.
 *
 * COST. This is DOM, so it costs no GPU frame time, but it can still cost CPU
 * if it is written carelessly. Rules followed throughout: the tick is throttled
 * to 30 Hz; every write goes through the change-gated setters in dom.js; the
 * only per-frame mutations are `transform` and custom properties, which the
 * compositor handles without layout; nothing reads geometry (offsetWidth,
 * getBoundingClientRect) during the tick; and when the mode is not 'play' the
 * whole thing early-returns before touching anything.
 */

import * as THREE from 'three';
import { el, attr, css, write, replay } from './dom.js';

const PPD = 3; // compass pixels per degree
const RING = 128; // detection ring radius, px
const TICK = 1 / 30; // HUD update period

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Bearing of a horizontal vector, radians, 0 = -Z (north), +clockwise. */
function bearing(dx, dz) {
  return Math.atan2(dx, -dz);
}
function wrapPi(a) {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

export class Hud {
  /**
   * @param {object} world
   * @param {ReturnType<import('./state.js').makeAdapter>} src
   * @param {(name:string)=>void} cue
   */
  constructor(world, src, cue) {
    this.world = world;
    this.src = src;
    this.cue = cue;

    this.alert = 'calm';
    this.health = 1;
    this._acc = 0;
    this._marks = new Map();
    this._sensors = [];
    this._objectives = [];
    this._objMarks = [];
    this._wpnHot = 0;
    this._objHot = 0;
    this._lastAmmo = null;
    this._objBearingOf = null;
    this._fwd = new THREE.Vector3();

    this.el = this._build();
  }

  _build() {
    // --- compass ---------------------------------------------------------
    this.rib = el('div.rib', { style: `width:${360 * 3 * PPD}px` });
    for (let copy = 0; copy < 3; copy++) {
      for (let d = 0; d < 360; d += 15) {
        const major = d % 45 === 0;
        const x = (d + copy * 360) * PPD;
        this.rib.appendChild(
          el('s', { style: `left:${x}px`, 'data-m': major ? (d % 90 === 0 ? '2' : '1') : '0' }, major ? [el('em', { text: CARDINALS[d / 45] })] : null),
        );
      }
    }
    this.cmp = el('div.cmp', null, [this.rib]);

    // --- alert -----------------------------------------------------------
    this.alrWord = el('em');
    this.alr = el('div.alr', null, [el('s'), this.alrWord, el('s')]);

    // --- detection ring --------------------------------------------------
    this.ring = el('div.ring');

    // --- objective -------------------------------------------------------
    this.objLabel = el('em');
    this.objDist = el('u');
    this.obj = el('div.obj', null, [el('b', { text: 'OBJ' }), this.objLabel, this.objDist]);

    // --- weapon / stance --------------------------------------------------
    this.stances = {
      stand: el('u', { 'data-k': 'stand' }),
      crouch: el('u', { 'data-k': 'crouch' }),
      prone: el('u', { 'data-k': 'prone' }),
    };
    this.wName = el('div.wnm');
    this.wAmmo = el('b');
    this.wReserve = el('u');
    this.wMode = el('div.wmd');
    this.wpn = el('div.wpn', null, [
      el('div.stn', null, [this.stances.stand, this.stances.crouch, this.stances.prone]),
      this.wName,
      el('div.amo', null, [this.wAmmo, el('i', { text: '/' }), this.wReserve]),
      this.wMode,
    ]);

    // --- damage -----------------------------------------------------------
    this.dmg = el('div.dmg');
    this.hit = el('div.hit');

    return el('section.hud', null, [this.cmp, this.alr, this.ring, this.obj, this.wpn, this.dmg, this.hit]);
  }

  /** Called by index.js when the AI (or the stand-in) reports a new phase. */
  setAlert(state) {
    if (state === this.alert) return;
    this.alert = state;
    write(this.alrWord, state === 'calm' ? '' : state);
    // Hard cut: restart the strobe rather than transitioning into it.
    if (state !== 'calm') replay(this.alr, 'cut');
    this.cue(`alert.${state}`);
  }

  /** Objective list override, used when gameplay publishes nothing. */
  setFallbackObjectives(list) {
    this._fallbackObjectives = list;
  }

  update(dt, engine) {
    this._acc += dt;
    if (this._acc < TICK) return;
    const step = this._acc;
    this._acc = 0;

    const cam = engine.camera;
    const p = this.src.player();

    // --- compass ----------------------------------------------------------
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const heading = bearing(fwd.x, fwd.z);
    const headingDeg = ((THREE.MathUtils.radToDeg(heading) % 360) + 360) % 360;
    css(this.rib, 'transform', `translateX(${(this.cmpHalf() - (headingDeg + 360) * PPD).toFixed(1)}px)`);

    // --- objectives -------------------------------------------------------
    const objs = this.src.objectives(this._objectives);
    const list = objs.length ? objs : (this._fallbackObjectives ?? []);
    const current = list.find((o) => !o.done) ?? list[list.length - 1] ?? null;
    if (current) {
      if (write(this.objLabel, current.label)) this._objHot = 6;
      if (current.x != null) {
        const d = Math.hypot(current.x - p.x, current.z - p.z);
        write(this.objDist, `${d.toFixed(0)} M`);
        this._objBearingOf = bearing(current.x - p.x, current.z - p.z);
      } else {
        write(this.objDist, '');
        this._objBearingOf = null;
      }
      attr(this.obj, 'data-done', current.done ? '1' : '0');
    }
    this._objHot = Math.max(0, this._objHot - step);
    css(this.obj, '--obj-o', current ? (this._objHot > 0 ? '1' : '0.55') : '0');
    this._syncObjectiveMarker();

    // --- detection --------------------------------------------------------
    const sensors = this.src.sensors(this._sensors);
    this._syncMarkers(sensors, p, heading);

    const hot = this.alert !== 'calm' || sensors.length > 0;
    css(this.cmp, '--cmp-o', hot ? '0.9' : '0.3');

    // --- weapon / stance ---------------------------------------------------
    const w = this.src.weapon();
    if (w) {
      write(this.wName, w.name);
      const ammoKey = `${w.ammo}/${w.reserve}/${w.name}`;
      if (this._lastAmmo !== ammoKey) {
        this._lastAmmo = ammoKey;
        this._wpnHot = 5;
      }
      write(this.wAmmo, String(w.ammo).padStart(2, '0'));
      write(this.wReserve, String(w.reserve).padStart(3, '0'));
      write(this.wMode, [w.suppressed ? 'SUPPRESSED' : null, w.mode].filter(Boolean).join(' · '));
      this._wpnHot = Math.max(0, this._wpnHot - step);
      css(this.wpn, '--wpn-o', this._wpnHot > 0 || hot ? '1' : '0.32');
    } else {
      // No weapon published: draw nothing rather than an empty chrome.
      css(this.wpn, '--wpn-o', '0');
    }

    const stance = this.src.stance();
    for (const k in this.stances) attr(this.stances[k], 'data-v', k === stance ? '1' : '0');

    // --- damage ------------------------------------------------------------
    const h = this.src.health();
    if (h < this.health - 0.001) replay(this.hit, 'on');
    this.health = h;
    // Capped: even at zero health the edge treatment must not become a wash.
    css(this.dmg, '--hurt', Math.min(0.9, Math.pow(1 - h, 1.4)).toFixed(3));
  }

  cmpHalf() {
    // Cached: the compass is a fixed fraction of the viewport and only changes
    // on resize, so this must never be measured inside the tick.
    return this._half ?? 0;
  }

  measure() {
    this._half = this.cmp.clientWidth / 2;
  }

  _syncObjectiveMarker() {
    let mark = this._objMarks[0];
    if (this._objBearingOf == null) {
      if (mark) css(mark, 'display', 'none');
      return;
    }
    if (!mark) {
      mark = el('div.obm');
      this._objMarks[0] = mark;
      this.rib.appendChild(mark);
    }
    css(mark, 'display', 'block');
    const deg = ((THREE.MathUtils.radToDeg(this._objBearingOf) % 360) + 360) % 360;
    css(mark, 'transform', `translateX(${((deg + 360) * PPD).toFixed(1)}px) rotate(45deg)`);
  }

  _syncMarkers(sensors, p, heading) {
    const seen = new Set();
    for (const s of sensors) {
      seen.add(s.id);
      let node = this._marks.get(s.id);
      if (!node) {
        node = el('div.mk', { style: `--r:${RING}px` }, [el('s'), el('i')]);
        this._marks.set(s.id, node);
        this.ring.appendChild(node);
      }
      const rel = wrapPi(bearing(s.x - p.x, s.z - p.z) - heading);
      css(node, 'transform', `rotate(${THREE.MathUtils.radToDeg(rel).toFixed(1)}deg)`);
      css(node, '--a', s.awareness.toFixed(2));
      attr(node, 'data-s', s.state);
    }
    // Sweep unconditionally: a tick that drops one sensor and gains another
    // leaves the counts equal, so comparing sizes would strand a dead marker.
    for (const [id, node] of this._marks) {
      if (seen.has(id)) continue;
      node.remove();
      this._marks.delete(id);
    }
  }

  /** Wipe every transient readout so re-entering play never shows stale state. */
  reset() {
    for (const [, node] of this._marks) node.remove();
    this._marks.clear();
    this.health = 1;
    this._wpnHot = 0;
    this._objHot = 0;
    this._lastAmmo = null;
    css(this.dmg, '--hurt', '0');
  }
}
