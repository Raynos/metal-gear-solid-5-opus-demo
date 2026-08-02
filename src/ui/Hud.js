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
 *                 awareness climbs, the range in metres, and a three-letter tag
 *                 naming WHY the meter is moving. See `_syncMarkers`.
 *   COMPASS       a scrolling degree ribbon with the objective pinned at its
 *                 true bearing.
 *   WEAPON        the instrument plate from the real game's bottom-right corner:
 *                 name, ammo-type chip, suppressor bar, MAGAZINE COMB, count.
 *   DAMAGE        an edge bloom driven by health, a directional wedge at the
 *                 bearing of whatever hit you, and a heartbeat when critical.
 *                 No health bar — MGSV does not have one.
 *
 * THE MAGAZINE COMB is the signature. Look at the reference frames: MGSV never
 * draws the magazine as a number alone. It draws one tick per round, in a comb
 * left of the count, and the ticks go out as you fire. It is the most
 * characteristic thing in that corner of the screen and the easiest to miss,
 * and it is the one place this HUD spends any boldness. Everything else in the
 * plate is hairlines and 9px mono.
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
const TICK = 1 / 30; // HUD update period

/** Below this the marker is a hint, not a warning: drawn, but without labels. */
const TRACE = 0.02;
/** Markers past this many are dropped. Eight chevrons is noise, not information. */
const MAX_MARKS = 6;
/** Metres of the meter climbing per second above which a contact is "closing". */
const URGENT_RATE = 0.35;

/** Two markers closer than this on the ring collide; the later one steps out. */
const LANE_ARC = THREE.MathUtils.degToRad(17);
/** Pixels each collision lane adds to the ring radius. */
const LANE_STEP = 40;

/** Cones past this many are noise; the most aware guards keep theirs. */
const MAP_CONES = 4;

/** Directional damage wedges recycled from a pool; four is more than enough. */
const WEDGES = 4;

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Minimap: half-extent in metres, and the viewBox half-extent it maps onto. */
const MAP_M = 130;
const MAP_R = 84;
/** Metres between range rings. */
const MAP_RING_M = 50;
/** Blips are clamped inside this radius, then drawn hollow. */
const MAP_EDGE = 76;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG element factory. `el()` from dom.js makes HTML elements, which do not
 *  render inside an <svg> — an html <circle> is an unknown inline element. */
function svg(tag, props) {
  const node = document.createElementNS(SVG_NS, tag);
  if (props) for (const k in props) if (props[k] != null) node.setAttribute(k, props[k]);
  return node;
}

/**
 * A unit vision wedge: apex at the origin, opening upward (-Y), full angle
 * `fovDeg`, radius 1. Scaled to the guard's own sight range at draw time, so
 * one path serves every guard at every range.
 */
function conePath(fovDeg) {
  const h = THREE.MathUtils.degToRad(fovDeg) * 0.5;
  const x = Math.sin(h).toFixed(4);
  const y = (-Math.cos(h)).toFixed(4);
  return `M0,0 L${-x},${y} A1,1 0 0,1 ${x},${y} Z`;
}

/**
 * Convex hull (Andrew's monotone chain) of `pts`, an array of [x, z].
 *
 * This is how the outpost footprint is found. `src/world/outpost` publishes no
 * perimeter polygon in world coordinates — only `isInside(x, z)`, a
 * point-in-polygon test against a 13-sided local perimeter — so the footprint
 * is recovered by sampling that test on a grid ONCE and hulling the hits. The
 * true perimeter is very slightly concave in places and the hull spans those,
 * which is the right error for a map outline to make: it never claims cover
 * that is not there.
 */
function hull(pts) {
  if (pts.length < 3) return pts;
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (src) => {
    const out = [];
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return build(p).concat(build(p.reverse()));
}

/** Bearing of a horizontal vector, radians, 0 = -Z (north), +clockwise. */
function bearing(dx, dz) {
  return Math.atan2(dx, -dz);
}
function wrapPi(a) {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}
const deg = (r) => THREE.MathUtils.radToDeg(r);

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
    /** null until something publishes health; see the note in state.js. */
    this.health = null;
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

    // Weapon block state.
    this._magSize = 0;      // ticks currently built
    this._magShown = -1;    // rounds currently lit
    this._magHigh = 0;      // highest magazine count ever seen — the inferred size
    this._wasReloading = false;

    // Damage state.
    this._hurtT = 0;        // seconds since the last health drop
    this._healT = 0;        // seconds of uninterrupted recovery
    this._wedgeI = 0;
    this._wedges = [];
    this._vitN = -1;        // segments currently built
    this._vitHot = 0;       // seconds the vitals block stays up after recovery

    // Map state. The footprint is sampled once; the pools are reused.
    this._foot = null;
    this._mCone = [];
    this._mBlip = [];

    this.el = this._build();
    /** Set by index.js: the frame and the scrim live on the root, not in here. */
    this.root = null;
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

    // --- weapon plate -----------------------------------------------------
    // Read bottom-up from the reference frames: name and ammo-type chip on top,
    // suppressor durability as a hairline bar, then the comb and the count
    // sharing a baseline. Nothing here is a fill except the plate itself.
    this.stances = {
      stand: el('u', { 'data-k': 'stand' }),
      crouch: el('u', { 'data-k': 'crouch' }),
      prone: el('u', { 'data-k': 'prone' }),
    };
    this.wName = el('em');
    this.wTag = el('i');
    this.wMag = el('div.mag');
    this.wAmmo = el('b');
    this.wReserve = el('u');
    this.wMode = el('div.wmd');
    this.wSupBar = el('i');
    this.wSup = el('div.sup', null, [el('b', { text: 'SUP' }), this.wSupBar]);
    this.wpn = el('div.wpn', null, [
      el('div.stn', null, [this.stances.stand, this.stances.crouch, this.stances.prone]),
      el('div.wpl', null, [
        el('div.wtop', null, [this.wName, this.wTag]),
        this.wSup,
        el('div.wbot', null, [this.wMag, el('div.amo', null, [this.wAmmo, el('i', { text: '/' }), this.wReserve])]),
        this.wMode,
      ]),
    ]);

    // --- vitals -----------------------------------------------------------
    this.vSeg = el('div.vsg');
    this.vWait = el('div.vwt');
    this.vit = el('div.vit', { 'data-wt': '0' }, [el('b', { text: 'VIT' }), this.vSeg, this.vWait]);

    // --- minimap ----------------------------------------------------------
    this.map = this._buildMap();

    // --- damage -----------------------------------------------------------
    this.dmg = el('div.dmg');
    this.hit = el('div.hit');
    this.dir = el('div.dir');
    for (let i = 0; i < WEDGES; i++) {
      const w = el('div.dw');
      this._wedges.push(w);
      this.dir.appendChild(w);
    }

    return el('section.hud', null, [this.cmp, this.alr, this.ring, this.map, this.vit, this.obj, this.wpn, this.dmg, this.dir, this.hit]);
  }

  /**
   * The map. Two coordinate systems, and keeping them apart is what makes the
   * per-frame cost one attribute write:
   *
   *   WORLD GROUP  the footprint and the vision cones live here in raw world
   *                metres. The whole group carries a single transform —
   *                `rotate(-heading) scale(k) translate(-player)` — so panning
   *                and turning the map is one string, not N.
   *   SCREEN       blips, the objective, the player and the N tick. These must
   *                keep a constant size at any zoom, so they are positioned in
   *                JS from the bearing and range the HUD already computed for
   *                the detection ring.
   */
  _buildMap() {
    const s = svg('svg', { class: 'mms', viewBox: `${-MAP_R} ${-MAP_R} ${MAP_R * 2} ${MAP_R * 2}` });

    this.mWorld = svg('g');
    this.mFoot = svg('polygon', { class: 'mmf' });
    this.mCones = svg('g');
    this.mWorld.append(this.mFoot, this.mCones);

    this.mRing = svg('circle', { class: 'mmr', cx: 0, cy: 0, r: (MAP_RING_M * MAP_R) / MAP_M });
    this.mBlips = svg('g');
    this.mObj = svg('path', { class: 'mmo', d: 'M0,-4 L4,0 L0,4 L-4,0 Z', style: 'display:none' });
    // The player is always at the centre facing up — that is what heading-up
    // means — so this never moves and never rotates.
    this.mYou = svg('path', { class: 'mmy', d: 'M0,-5.5 L4,4.5 L0,2 L-4,4.5 Z' });
    this.mN = svg('text', { class: 'mmn', x: 0, y: 0, text: 'N' });
    this.mN.textContent = 'N';

    s.append(this.mWorld, this.mRing, this.mBlips, this.mObj, this.mYou, this.mN);
    return el('div.mmp', null, [s, el('b.mmsc', { text: `${MAP_RING_M}M` })]);
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
    const headingDeg = ((deg(heading) % 360) + 360) % 360;
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
    const live = this._syncMarkers(sensors, p, heading);
    this._syncMap(sensors, p, heading, current);

    const hot = this.alert !== 'calm' || live > 0;
    css(this.cmp, '--cmp-o', hot ? '0.9' : '0.3');

    // --- weapon / stance ---------------------------------------------------
    this._syncWeapon(this.src.weapon(), step, hot);

    const stance = this.src.stance();
    for (const k in this.stances) attr(this.stances[k], 'data-v', k === stance ? '1' : '0');

    // --- damage ------------------------------------------------------------
    this._syncHealth(this.src.health(), step);
    this._syncVitals(this.src.vitals(), step);
  }

  // ------------------------------------------------------------ vitals --

  /**
   * The comb. One segment per rifle round you can still take.
   *
   * Absent at full health on purpose — see the note in style.js. The two states
   * that are NOT just "less health" each get their own mark, because each one
   * implies a different decision: `regen` (the sweep) means staying out of
   * sight is now paying off, and `untilRegen` (the depleting hairline) is how
   * much longer you have to keep it up before it starts.
   */
  _syncVitals(v, step) {
    if (!v) {
      css(this.vit, '--vit-o', '0');
      return;
    }
    if (v.segments !== this._vitN && v.segments > 0 && v.segments <= 24) {
      this._vitN = v.segments;
      this.vSeg.replaceChildren(...Array.from({ length: v.segments }, () => el('s')));
    }
    const lit = v.health * this._vitN;
    const seg = this.vSeg.children;
    for (let i = 0; i < seg.length; i++) {
      css(seg[i], '--f', Math.max(0, Math.min(1, lit - i)).toFixed(2));
    }

    const hurt = v.health < 0.999;
    if (hurt) this._vitHot = 5;
    else this._vitHot = Math.max(0, this._vitHot - step);
    css(this.vit, '--vit-o', hurt ? '1' : this._vitHot > 0 ? '0.5' : '0');

    attr(this.vit, 'data-rg', v.regen ? '1' : null);
    const wait = v.untilRegen;
    const waiting = hurt && wait != null && wait > 0.05;
    attr(this.vit, 'data-wt', waiting ? '1' : '0');
    if (waiting) css(this.vWait, '--w', `${Math.min(100, (wait / (v.regenDelay || 4)) * 100).toFixed(0)}%`);
  }

  // --------------------------------------------------------------- map --

  /**
   * Recover the outpost outline once. `src/world/outpost` publishes no world
   * -space perimeter, only `isInside(x, z)`, so it is sampled on a grid and
   * hulled. ~1.7 k point-in-polygon tests, one time, at the first tick in play.
   */
  _footprint() {
    if (this._foot) return this._foot;
    const o = this.src.outpost();
    if (!o) return null;
    const { minX, minZ, maxX, maxZ } = o.bounds;
    let pts = [];
    if (o.isInside) {
      const N = 40;
      for (let i = 0; i <= N; i++) {
        const x = minX + ((maxX - minX) * i) / N;
        for (let j = 0; j <= N; j++) {
          const z = minZ + ((maxZ - minZ) * j) / N;
          if (o.isInside(x, z)) pts.push([x, z]);
        }
      }
      pts = hull(pts);
    }
    // No perimeter test, or it never answered true: the bounds box is the
    // honest fallback — it is still where the compound is.
    if (pts.length < 3) pts = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
    this._foot = pts;
    this.mFoot.setAttribute('points', pts.map(([x, z]) => `${x.toFixed(1)},${z.toFixed(1)}`).join(' '));
    return pts;
  }

  /**
   * WHAT THE MAP IS ALLOWED TO SHOW is the only real design rule in here, and
   * it is a stealth rule, not a graphics one: in CALM the map draws only men
   * whose meter has actually moved. Drawing the whole garrison all the time
   * would make the map a wall-hack and delete the tension the entire game is
   * built on. From CAUTION up the garrison is hunting and its positions are
   * fair — that is when the vision cones come on too.
   */
  _syncMap(sensors, p, heading, objective) {
    this._footprint();

    const k = MAP_R / MAP_M;
    // One transform for everything in world space.
    attr(
      this.mWorld,
      'transform',
      `rotate(${(-deg(heading)).toFixed(2)}) scale(${k.toFixed(4)}) translate(${(-p.x).toFixed(2)} ${(-p.z).toFixed(2)})`,
    );

    const open = this.alert !== 'calm';
    let nb = 0;
    let nc = 0;
    for (const s of sensors) {
      if (!open && s.awareness <= 0) continue;

      const dx = s.x - p.x;
      const dz = s.z - p.z;
      const rel = wrapPi(bearing(dx, dz) - heading);
      const dist = Math.hypot(dx, dz);
      let r = dist * k;
      const off = r > MAP_EDGE;
      if (off) r = MAP_EDGE;

      let blip = this._mBlip[nb];
      if (!blip) {
        blip = svg('rect', { class: 'mmg', x: -2.2, y: -2.2, width: 4.4, height: 4.4 });
        this._mBlip[nb] = blip;
        this.mBlips.appendChild(blip);
      }
      nb++;
      attr(blip, 'transform', `translate(${(r * Math.sin(rel)).toFixed(2)} ${(-r * Math.cos(rel)).toFixed(2)})`);
      attr(blip, 'data-s', s.tier);
      attr(blip, 'data-off', off ? '1' : null);
      css(blip, 'display', '');

      // Cones need a heading and a range, and `contacts()` publishes neither —
      // both are joined off the raw Guard in state.js and may be absent.
      // `sensors` arrives sorted by awareness, so the cap keeps the cones that
      // belong to the men who have most nearly found you.
      if (open && nc < MAP_CONES && s.yaw != null && s.range) {
        let cone = this._mCone[nc];
        if (!cone) {
          cone = svg('path', { class: 'mmc', d: conePath(120) });
          this._mCone[nc] = cone;
          this.mCones.appendChild(cone);
        }
        nc++;
        attr(cone, 'transform', `translate(${s.x.toFixed(1)} ${s.z.toFixed(1)}) rotate(${(-deg(s.yaw)).toFixed(1)}) scale(${s.range.toFixed(1)})`);
        attr(cone, 'data-s', s.tier);
        css(cone, 'display', '');
      }
    }
    for (let i = nb; i < this._mBlip.length; i++) css(this._mBlip[i], 'display', 'none');
    for (let i = nc; i < this._mCone.length; i++) css(this._mCone[i], 'display', 'none');

    // The objective, clamped to the edge like a blip so it always says which
    // way to go even from the insertion point a hundred metres out.
    if (objective && objective.x != null) {
      const rel = wrapPi(bearing(objective.x - p.x, objective.z - p.z) - heading);
      const r = Math.min(MAP_EDGE, Math.hypot(objective.x - p.x, objective.z - p.z) * k);
      css(this.mObj, 'display', '');
      attr(this.mObj, 'transform', `translate(${(r * Math.sin(rel)).toFixed(2)} ${(-r * Math.cos(rel)).toFixed(2)})`);
    } else {
      css(this.mObj, 'display', 'none');
    }

    // North. The only absolute reference on a heading-up map.
    const n = -heading;
    attr(this.mN, 'x', (72 * Math.sin(n)).toFixed(1));
    attr(this.mN, 'y', (-72 * Math.cos(n) + 3).toFixed(1));
  }

  // ------------------------------------------------------------ weapon --

  /**
   * The plate. `w` is the descriptor from state.js's `weapon()`, or null.
   *
   * `magSize` is the interesting case. Gameplay publishes it or it does not;
   * when it does not, the highest magazine count seen so far IS the magazine
   * size, exactly, from the first full magazine onward — and the player starts
   * with a full one, so in practice it is right on frame one. Guessing a
   * constant here would duplicate MAG_SIZE from src/gameplay/Stealth.js and go
   * stale the day someone changes the loadout.
   */
  _syncWeapon(w, step, hot) {
    if (!w) {
      css(this.wpn, '--wpn-o', '0');
      return;
    }

    write(this.wName, w.name);

    // Ammo-type chip. MGSV writes the payload, not the calibre: ZZZ for a
    // tranquilliser, DMG for lethal. Anything we cannot name gets no chip
    // rather than a made-up one.
    const tranq = w.kind.includes('tranq') || w.name.includes('TRANQ');
    const tag = tranq ? 'ZZZ' : w.kind || w.mode ? 'DMG' : '';
    write(this.wTag, tag);
    attr(this.wTag, 'data-k', tag === 'ZZZ' ? 'tranq' : tag ? 'lethal' : null);

    css(this.wSup, 'display', w.suppressed ? '' : 'none');
    attr(this.wSupBar, 'data-v', w.supLife == null ? '?' : '1');
    if (w.supLife != null) css(this.wSupBar, '--sup', `${(w.supLife * 100).toFixed(0)}%`);

    // --- the comb -------------------------------------------------------
    const size = w.magSize ?? (this._magHigh = Math.max(this._magHigh, w.ammo));
    if (size !== this._magSize && size > 0 && size <= 60) {
      this._magSize = size;
      this._magShown = -1;
      this.wMag.replaceChildren(...Array.from({ length: size }, () => el('s')));
    }
    if (this._magShown !== w.ammo) {
      this._magShown = w.ammo;
      const ticks = this.wMag.children;
      for (let i = 0; i < ticks.length; i++) attr(ticks[i], 'data-v', i < w.ammo ? '1' : '0');
    }
    // The reload sweep is indeterminate on purpose: round 8's gameplay reports
    // `reloading` as a boolean with no duration, and a progress bar that
    // invents its own timing is worse than one that only says "working".
    attr(this.wMag, 'data-rl', w.reloading ? '1' : null);
    if (w.reloading && !this._wasReloading) this.cue('weapon.reload');
    this._wasReloading = w.reloading;

    write(this.wAmmo, String(w.ammo).padStart(2, '0'));
    // A reserve of null means gameplay does not track one. Three dashes is the
    // instrument-panel way of saying "no reading", and it keeps the baseline.
    write(this.wReserve, w.reserve == null ? '---' : String(w.reserve).padStart(3, '0'));
    attr(this.wAmmo, 'data-empty', w.ammo === 0 ? '1' : null);
    write(this.wMode, w.mode);

    const ammoKey = `${w.ammo}/${w.reserve}/${w.name}/${w.reloading}`;
    if (this._lastAmmo !== ammoKey) {
      this._lastAmmo = ammoKey;
      this._wpnHot = 5;
    }
    this._wpnHot = Math.max(0, this._wpnHot - step);
    // Calm and untouched, the plate sits at a third — present enough to find,
    // quiet enough to ignore. Any event or any alert brings it fully up.
    css(this.wpn, '--wpn-o', this._wpnHot > 0 || hot ? '1' : '0.34');
  }

  // ------------------------------------------------------------ damage --

  /**
   * Three tiers, no bar. `ok` draws nothing; `hurt` is a steady red edge;
   * `critical` is the same edge with a slow pulse, which is the one piece of
   * motion in this HUD that repeats. Recovery is its own signal — the edge
   * cools toward bone for a beat rather than just vanishing, so healing reads
   * as an event and not as a bug.
   */
  _syncHealth(h, step) {
    if (h == null) {
      // Nothing publishes health. Draw no damage state at all rather than
      // asserting full health, which is what a default of 1 used to do.
      css(this.dmg, '--hurt', '0');
      this._hpState(null);
      return;
    }
    const prev = this.health;
    this.health = h;
    if (prev == null) {
      this._hpState('ok');
      return;
    }

    if (h < prev - 0.001) {
      replay(this.hit, 'on');
      this._hurtT = 0;
      this._healT = 0;
      this.cue('player.hurt');
    } else if (h > prev + 0.001 && h < 1) {
      this._healT += step;
    } else {
      this._hurtT += step;
    }

    if (prev < 1 && h >= 0.999) {
      this._healT = 0;
      replay(this.dmg, 'heal');
      this.cue('player.recovered');
    }

    // Capped: even at zero health the edge treatment must not become a wash.
    css(this.dmg, '--hurt', Math.min(0.9, Math.pow(1 - h, 1.4)).toFixed(3));
    this._hpState(h <= 0.001 ? 'down' : h < 0.34 ? 'critical' : h < 0.999 ? 'hurt' : 'ok');
  }

  /** The wound state lives on both nodes: .hud drives the vignette, .ui the frame. */
  _hpState(v) {
    attr(this.el, 'data-hp', v);
    if (this.root) attr(this.root, 'data-hp', v);
  }

  /**
   * Something hit you, or shot at you, from `world`. The wedge is the only
   * element in this HUD that appears at a bearing without a marker attached:
   * it is a one-shot, it is gone in under a second, and it is the difference
   * between "I am being shot" and "I am being shot FROM THERE".
   *
   * @param {{x:number,z:number}} from  world position of the source
   * @param {'hit'|'near'} kind         a round that landed, or one that missed
   */
  incoming(from, kind = 'hit') {
    if (!from) return;
    const p = this.src.player();
    const cam = this.world.engine.camera;
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const rel = wrapPi(bearing(from.x - p.x, from.z - p.z) - bearing(fwd.x, fwd.z));
    const node = this._wedges[this._wedgeI++ % WEDGES];
    css(node, 'transform', `rotate(${deg(rel).toFixed(1)}deg)`);
    attr(node, 'data-k', kind);
    replay(node, 'on');
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
    const d = ((deg(this._objBearingOf) % 360) + 360) % 360;
    css(mark, 'transform', `translateX(${((d + 360) * PPD).toFixed(1)}px) rotate(45deg)`);
  }

  /**
   * One marker per contact, on a ring at screen centre, at the true bearing.
   *
   * Four things have to be legible at a glance, and the layout is built around
   * exactly those and nothing else:
   *
   *   WHERE    position on the ring — the bearing is the whole point, and it
   *            works for a guard behind you, which no world-space marker does.
   *   HOW MUCH the meter, cut at the AI's own NOTICE / SUSPECT / DETECT
   *            thresholds so the colour change lands on the same frame the
   *            guard's behaviour changes.
   *   HOW FAR  range in metres, mono, above the glyph.
   *   WHY      SIGHT / NOISE / SEARCH / CONTACT / LOST. Without this the meter
   *            is a mystery and the player cannot learn what to stop doing.
   *
   * The marker body is counter-rotated so type stays upright — a rotated 8px
   * label is unreadable, and MGSV's own markers are screen-aligned.
   *
   * @returns {number} how many are drawn
   */
  _syncMarkers(sensors, p, heading) {
    // Loudest first, then cap. Eight simultaneous chevrons is a decoration.
    sensors.sort((a, b) => b.awareness - a.awareness);
    const seen = new Set();
    let drawn = 0;
    /** Bearings already placed, so a second marker at the same one can be moved. */
    const lanes = [];

    for (const s of sensors) {
      if (s.awareness <= TRACE || drawn >= MAX_MARKS) break;
      drawn++;
      seen.add(s.id);
      let node = this._marks.get(s.id);
      if (!node) {
        node = el('div.mk', null, [
          el('div.mkl', null, [el('u'), el('s'), el('i'), el('em')]),
        ]);
        node.__l = node.firstChild;
        // u = range, s = glyph, i = meter, em = reason. Only the two text
        // nodes are addressed again; the glyph and meter are pure CSS.
        node.__d = node.__l.children[0];
        node.__r = node.__l.children[3];
        this._marks.set(s.id, node);
        this.ring.appendChild(node);
      }
      const rel = deg(wrapPi(bearing(s.x - p.x, s.z - p.z) - heading));

      // DE-CONFLICTION, and it is the difference between a readable ring and
      // the pile this used to draw. Four guards on the same side of you land on
      // the same few degrees of ring and their labels sit on top of each other,
      // which is worse than drawing nothing — it looks like corruption. Moving
      // them along the bearing would be a lie, since the bearing IS the
      // information, so instead each collision steps one lane further out. The
      // angle stays true and the type stops colliding.
      let lane = 0;
      while (lanes.some((l) => l.lane === lane && Math.abs(wrapPi(THREE.MathUtils.degToRad(l.rel - rel))) < LANE_ARC)) lane++;
      lanes.push({ rel, lane });
      css(node, '--r', `calc(var(--r0) + ${lane * LANE_STEP}px)`);

      css(node, 'transform', `rotate(${rel.toFixed(1)}deg)`);
      css(node.__l, '--nr', `${(-rel).toFixed(1)}deg`);
      css(node, '--a', s.awareness.toFixed(2));
      attr(node, 'data-s', s.tier);
      attr(node, 'data-seeing', s.seeing ? '1' : null);
      // Filling fast and not yet certain: that is the moment worth reacting
      // to, and the only thing on this HUD that gets to blink.
      attr(node, 'data-urgent', s.rate > URGENT_RATE && s.awareness < 0.999 ? '1' : null);
      const d = s.dist ?? Math.hypot(s.x - p.x, s.z - p.z);
      write(node.__d, `${d.toFixed(0)}m`);
      write(node.__r, s.reason);
    }

    // Sweep unconditionally: a tick that drops one sensor and gains another
    // leaves the counts equal, so comparing sizes would strand a dead marker.
    for (const [id, node] of this._marks) {
      if (seen.has(id)) continue;
      node.remove();
      this._marks.delete(id);
    }
    return drawn;
  }

  /** Wipe every transient readout so re-entering play never shows stale state. */
  reset() {
    for (const [, node] of this._marks) node.remove();
    this._marks.clear();
    this.health = null;
    this._wpnHot = 0;
    this._objHot = 0;
    this._lastAmmo = null;
    this._magShown = -1;
    this._magHigh = 0;
    this._hurtT = 0;
    this._healT = 0;
    this._wasReloading = false;
    this._vitHot = 0;
    css(this.vit, '--vit-o', '0');
    css(this.dmg, '--hurt', '0');
    this._hpState(null);
    for (const w of this._wedges) w.classList.remove('on');
    // The map's own state is the outpost footprint, which does not move, so it
    // survives a restart deliberately. The transient marks do not.
    for (const b of this._mBlip) css(b, 'display', 'none');
    for (const c of this._mCone) css(c, 'display', 'none');
  }
}
