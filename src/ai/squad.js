import * as THREE from 'three';

/**
 * The alert ladder, MGSV's exact shape, and the squad blackboard that carries
 * information between guards.
 *
 *   CALM     nobody knows anything. Patrols and posts.
 *   CAUTION  something was noticed — a noise, a glimpse, an open door. One or
 *            two men break off and go and look. Nobody is shooting.
 *   ALERT    positive ID, a shot, or a body. The garrison converges on the last
 *            known position and engages.
 *   EVASION  they had you and lost you. The sweep: guards fan out from the last
 *            known position and search a widening area. This is the state the
 *            player actually spends the most time in.
 *
 * and back down: EVASION -> CAUTION -> CALM on timers, each of which is reset
 * by any fresh stimulus.
 *
 * Everything a guard learns goes through `report()`, so one man seeing you
 * escalates the whole squad. That is the difference between a stealth game and
 * eight independent monsters.
 */

export const LEVELS = ['CALM', 'CAUTION', 'ALERT', 'EVASION'];

const TIMERS = {
  /** No fresh stimulus for this long and CAUTION relaxes to CALM. */
  cautionHold: 26,
  /** ALERT without a confirmed sighting for this long drops to EVASION. */
  alertLoss: 14,
  /** The sweep. When it expires the garrison steps down to CAUTION. */
  evasionHold: 42,
  /** A guard who reports something is on the radio for this long. */
  radio: 1.6,
};

export class Squad {
  constructor(rand) {
    this.rand = rand;
    this.level = 'CALM';
    this.timer = 0;
    /** Where the squad believes the target is. */
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    /** Direction the target was last moving, so the sweep leads rather than lags. */
    this.lastHeading = new THREE.Vector3(0, 0, 1);
    this.lastKnownAge = 0;
    /** Points already assigned to a searcher this sweep, so they spread out. */
    this.searchClaims = [];
    this.listeners = new Set();
    this.events = new Set();
    /** Set true for one tick when the level changed — the HUD stinger reads it. */
    this.justChanged = false;
    this.history = [];
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn) {
    this.events.add(fn);
    return () => this.events.delete(fn);
  }

  _emit(ev) {
    for (const fn of this.events) {
      try { fn(ev); } catch (e) { /* a listener must not break the AI */ }
    }
  }

  set(level, position, reason) {
    if (level === this.level) return;
    const from = this.level;
    this.level = level;
    this.justChanged = true;
    this.history.push({ from, to: level, reason });
    if (this.history.length > 32) this.history.shift();
    const payload = {
      from,
      to: level,
      reason: reason ?? null,
      position: position ? position.clone() : (this.hasLastKnown ? this.lastKnown.clone() : null),
    };
    for (const fn of this.listeners) {
      try { fn(payload); } catch (e) { /* likewise */ }
    }
    this._emit({ type: 'alert', ...payload });
  }

  /**
   * Every stimulus in the game arrives here.
   *
   *   'notice'   a guard's meter crossed SUSPECT — worth a look
   *   'noise'    something was heard
   *   'sight'    positive ID
   *   'gunshot'  a weapon was fired
   *   'body'     a man was found down
   *   'contact'  a guard was shot at / hit
   */
  report(kind, position, from = null) {
    if (position) {
      this.lastKnown.copy(position);
      this.hasLastKnown = true;
      this.lastKnownAge = 0;
      this.searchClaims.length = 0;
    }
    this._emit({ type: kind, position: position ? position.clone() : null, from: from?.id ?? null });

    switch (kind) {
      case 'sight':
      case 'gunshot':
      case 'contact':
        this.timer = TIMERS.alertLoss;
        this.set('ALERT', position, kind);
        break;
      case 'body':
        // Finding a man down is not "investigate": it is proof of an intruder.
        this.timer = TIMERS.alertLoss;
        this.set('ALERT', position, 'body');
        break;
      case 'notice':
      case 'noise':
        if (this.level === 'CALM') {
          this.timer = TIMERS.cautionHold;
          this.set('CAUTION', position, kind);
        } else if (this.level === 'CAUTION') {
          this.timer = TIMERS.cautionHold;
        } else if (this.level === 'EVASION') {
          // A sweep that finds a fresh trail restarts, it does not stand down.
          this.timer = Math.max(this.timer, TIMERS.evasionHold * 0.6);
        }
        break;
      default:
        break;
    }
  }

  /** Called while a guard has the target in view — keeps ALERT from decaying. */
  refresh(position, heading) {
    this.lastKnown.copy(position);
    this.hasLastKnown = true;
    this.lastKnownAge = 0;
    if (heading) this.lastHeading.copy(heading);
    if (this.level === 'ALERT') this.timer = TIMERS.alertLoss;
  }

  update(dt) {
    this.justChanged = false;
    this.lastKnownAge += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    switch (this.level) {
      case 'ALERT':
        this.timer = TIMERS.evasionHold;
        this.searchClaims.length = 0;
        this.set('EVASION', null, 'lost contact');
        break;
      case 'EVASION':
        this.timer = TIMERS.cautionHold;
        this.set('CAUTION', null, 'sweep expired');
        break;
      case 'CAUTION':
        this.hasLastKnown = false;
        this.set('CALM', null, 'stood down');
        break;
      default:
        this.timer = 1;
        break;
    }
  }

  /**
   * Hand a searcher somewhere to look. Points are drawn on an expanding ring
   * around the last known position, biased down the direction the target was
   * last heading, and claimed so two men do not sweep the same patch.
   */
  claimSearchPoint(grid, guard) {
    if (!this.hasLastKnown) return null;
    const spread = this.level === 'EVASION' ? 9 + Math.min(26, this.lastKnownAge * 0.85) : 5;
    for (let attempt = 0; attempt < 14; attempt++) {
      const a = this.rand() * Math.PI * 2;
      const r = spread * (0.35 + this.rand() * 0.65);
      const lead = this.level === 'EVASION' ? 0.55 : 0.2;
      const x = this.lastKnown.x + Math.cos(a) * r + this.lastHeading.x * spread * lead;
      const z = this.lastKnown.z + Math.sin(a) * r + this.lastHeading.z * spread * lead;
      if (!grid.walkable(x, z)) continue;
      let taken = false;
      for (const c of this.searchClaims) {
        if ((c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < 64) { taken = true; break; }
      }
      if (taken) continue;
      const p = new THREE.Vector3(x, grid.heightAt(x, z), z);
      this.searchClaims.push(p);
      if (this.searchClaims.length > 24) this.searchClaims.shift();
      return p;
    }
    return null;
  }
}

export { TIMERS };
