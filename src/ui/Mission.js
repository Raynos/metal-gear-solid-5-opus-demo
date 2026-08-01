/**
 * Mission.js — the objective flow: title card, objective list, end cards.
 *
 * MGSV's mission-start card is white type cut onto black, held, then lifted off
 * the live frame. Reproducing it takes three things and no more: a hard cut to
 * an opaque plate (no fade IN — the cut is the whole gesture), a tracking
 * collapse on the title, and a plate fade that is slower than the type fade so
 * the world arrives before the words leave.
 *
 * The objective list is read from `registry.gameplay` when it exists. When it
 * does not, the three objectives the brief names are used, and the first one is
 * advanced from real geometry — distance from the player to the outpost — so
 * even the fallback is measuring the world rather than pretending.
 */

import { el, write } from './dom.js';

const TIMELINE = { in: 0.2, hold: 2.4, out: 0.85 };

export class Mission {
  /**
   * @param {object} world
   * @param {ReturnType<import('./state.js').makeAdapter>} src
   * @param {(name:string)=>void} cue
   */
  constructor(world, src, cue) {
    this.world = world;
    this.src = src;
    this.cue = cue;

    this.elapsed = 0;
    this.alerts = 0;
    this.running = false;
    this._t = -1;
    this._card = null;
    this._lastMission = null;

    // The outpost's own centre if it publishes one; the compound sits on the
    // origin otherwise.
    const o = world.registry.outpost;
    const c = o?.center ?? o?.centre ?? o?.origin;
    this.site = { x: c?.x ?? c?.[0] ?? 0, z: c?.z ?? c?.[1] ?? 0 };

    this.fallback = [
      { id: 'infil', label: 'INFILTRATE THE OUTPOST', done: false, x: this.site.x, z: this.site.z },
      { id: 'neutralise', label: 'NEUTRALISE THE COMMANDER', done: false, x: this.site.x, z: this.site.z },
      { id: 'exfil', label: 'EXFILTRATE', done: false, x: null, z: null },
    ];

    this.el = this._build();
  }

  _build() {
    this.ck = el('div.ck', null, [el('s'), (this.ckText = el('span'))]);
    this.ct = el('div.ct');
    this.cm = el('div.cm');
    this.plate = el('div.plate');
    return el('div.cin', null, [this.plate, el('div.card', null, [this.ck, this.ct, this.cm])]);
  }

  _meta(pairs) {
    this.cm.replaceChildren(...pairs.map(([k, v]) => el('span', null, [el('i', { text: k }), el('span', { text: v })])));
  }

  _show(kind, kicker, title, meta) {
    this._card = kind;
    this._t = 0;
    write(this.ckText, kicker);
    // The tracking-collapse keyframe is bound to the element, so it has to be
    // re-created to replay rather than restarted.
    this.ct.replaceWith((this.ct = el('div.ct', { text: title })));
    this._meta(meta);
    this.el.setAttribute('data-card', kind);
    this.el.removeAttribute('data-out');
    this.cue(`mission.${kind}`);
  }

  /** Enter play: cut to black, name the mission, lift off. */
  start() {
    this.elapsed = 0;
    this.alerts = 0;
    this.running = true;
    for (const o of this.fallback) o.done = false;
    this._lastMission = null;
    const name = this.src.missionName() ?? 'INFILTRATE THE OUTPOST';
    this._show('start', 'Mission 01', name, [
      ['LOC', 'AFGHANISTAN'],
      ['TIME', (this.world.lighting?.todName ?? 'AFTERNOON').toUpperCase()],
      ['OPFOR', 'UNKNOWN STRENGTH'],
    ]);
  }

  /** @param {'accomplished'|'failed'} result */
  end(result) {
    if (!this.running) return;
    this.running = false;
    const m = Math.floor(this.elapsed / 60);
    const s = Math.floor(this.elapsed % 60);
    this._show(result === 'failed' ? 'failed' : 'accomplished', 'Operation 51-J', result === 'failed' ? 'Mission failed' : 'Mission accomplished', [
      ['TIME', `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`],
      ['ALERTS', String(this.alerts).padStart(2, '0')],
    ]);
    // The end card holds until it is dismissed, not on a timer.
    this._t = -1;
    this.el.setAttribute('data-card', result === 'failed' ? 'failed' : 'accomplished');
  }

  /** Tear the card down immediately — used when leaving play. */
  clear() {
    this.running = false;
    this._card = null;
    this._t = -1;
    this.el.removeAttribute('data-card');
    this.el.removeAttribute('data-out');
  }

  countAlert() {
    this.alerts++;
  }

  update(dt) {
    if (this.running) this.elapsed += dt;

    // Fallback objective advance: real distance, not a script. Only while
    // gameplay publishes no objective list of its own.
    if (this.running && this.src.objectives(this._scratch ?? (this._scratch = [])).length === 0) {
      const p = this.src.player();
      const infil = this.fallback[0];
      if (!infil.done && Math.hypot(p.x - this.site.x, p.z - this.site.z) < 46) infil.done = true;
    }

    // Mirror gameplay's own mission result if it publishes one.
    const state = this.src.mission();
    if (state && state !== this._lastMission) {
      this._lastMission = state;
      if (state === 'accomplished' || state === 'failed') this.end(state);
    }

    if (this._t < 0) return;
    this._t += dt;
    if (this._card === 'start') {
      if (this._t > TIMELINE.in + TIMELINE.hold && !this.el.hasAttribute('data-out')) this.el.setAttribute('data-out', '1');
      if (this._t > TIMELINE.in + TIMELINE.hold + TIMELINE.out) {
        this._t = -1;
        this._card = null;
        this.el.removeAttribute('data-card');
        this.el.removeAttribute('data-out');
      }
    }
  }
}
