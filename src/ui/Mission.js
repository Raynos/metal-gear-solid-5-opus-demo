/**
 * Mission.js — the objective flow: title card, objective list, end cards.
 *
 * MGSV's mission-start card is white type cut onto black, held, then lifted off
 * the live frame. Reproducing it takes three things and no more: a hard cut to
 * an opaque plate (no fade IN — the cut is the whole gesture), a tracking
 * collapse on the title, and a plate fade that is slower than the type fade so
 * the world arrives before the words leave.
 *
 * THE END CARDS work the same way with one addition, and it is the whole
 * difference between a result screen and MGSV's result screen: A BEAT OF
 * SILENCE. The plate cuts to black instantly on the frame the mission ends, and
 * then nothing happens for 900 ms. No spinner, no fade, no sound. Only after
 * that does the kicker appear, and the title a beat behind it. Everything
 * bright and fast that games normally do here — the flourish, the score
 * counting up, the stinger on the cut — is exactly what MGSV does not do, and
 * the restraint is what makes MISSION FAILED land.
 *
 * The card then HOLDS. It does not time out, because the two things it offers
 * are decisions: retry, or go back. Both are on screen as hairline prompts in
 * the same 9px mono as every other readout in this UI, and both are driven from
 * index.js, which owns the keyboard.
 *
 * The objective list is read from gameplay when it publishes one. When it does
 * not, the three objectives the brief names are used, and the first one is
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
    /** 'accomplished' | 'failed' while an end card is up and awaiting a key. */
    this.result = null;
    this._t = -1;
    this._card = null;
    this._lastMission = null;

    // The outpost's own centre if it publishes one; the compound sits on the
    // origin otherwise.
    const o = world.registry.outpost;
    const c = o?.center ?? o?.centre ?? o?.origin;
    this.site = { x: c?.x ?? c?.[0] ?? 0, z: c?.z ?? c?.[1] ?? 0 };

    /**
     * The fallback mission, and the only one there is until gameplay publishes
     * objectives of its own. Every clause is scored off state that actually
     * exists in the build: distance to the outpost, and how many of the AI's
     * guards are `down`. The round-7 brief targeted "the commander", who is not
     * a character anyone placed — an objective that can never complete is worse
     * than no objective, so it is gone.
     */
    this.quota = 4;
    this.fallback = [
      { id: 'infil', label: 'INFILTRATE THE OUTPOST', done: false, x: this.site.x, z: this.site.z },
      { id: 'clear', label: `NEUTRALISE ${this.quota} SENTRIES`, done: false, x: this.site.x, z: this.site.z },
      { id: 'exfil', label: 'EXFILTRATE — 120 M', done: false, x: null, z: null },
    ];

    this.el = this._build();
  }

  _build() {
    this.ck = el('div.ck', null, [el('s'), (this.ckText = el('span'))]);
    this.ct = el('div.ct');
    this.cm = el('div.cm');
    this.cp = el('div.cp');
    this.plate = el('div.plate');
    return el('div.cin', null, [this.plate, el('div.card', null, [this.ck, this.ct, this.cm, this.cp])]);
  }

  _meta(pairs) {
    this.cm.replaceChildren(...pairs.map(([k, v]) => el('span', null, [el('i', { text: k }), el('span', { text: v })])));
  }

  /** Hairline key prompts under an end card. `pairs` is [key, action][]. */
  _prompts(pairs) {
    this.cp.replaceChildren(...pairs.map(([k, v]) => el('span', null, [el('b', { text: k }), el('span', { text: v })])));
  }

  _show(kind, kicker, title, meta, prompts = null) {
    this._card = kind;
    this._t = 0;
    write(this.ckText, kicker);
    // The tracking-collapse keyframe is bound to the element, so it has to be
    // re-created to replay rather than restarted.
    this.ct.replaceWith((this.ct = el('div.ct', { text: title })));
    this._meta(meta);
    this._prompts(prompts ?? []);
    this.el.setAttribute('data-card', kind);
    this.el.removeAttribute('data-out');
  }

  /** Enter play: cut to black, name the mission, lift off. */
  start() {
    this.elapsed = 0;
    this.alerts = 0;
    this.running = true;
    this.result = null;
    for (const o of this.fallback) o.done = false;
    this._lastMission = null;
    const name = this.src.missionName() ?? 'INFILTRATE THE OUTPOST';
    this._show('start', 'Mission 01', name, [
      ['LOC', 'AFGHANISTAN'],
      ['TIME', (this.world.lighting?.todName ?? 'AFTERNOON').toUpperCase()],
      ['OPFOR', 'UNKNOWN STRENGTH'],
    ]);
    this.cue('mission.start');
  }

  /**
   * @param {'accomplished'|'failed'} result
   * @param {string} [because]  one clause naming what ended it, e.g. 'KILLED IN ACTION'
   */
  end(result, because, rank = null) {
    if (!this.running) return;
    this.running = false;
    const kind = result === 'failed' ? 'failed' : 'accomplished';
    this.result = kind;
    const m = Math.floor(this.elapsed / 60);
    const s = Math.floor(this.elapsed % 60);
    const meta = [
      ['TIME', `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`],
      ['ALERTS', String(this.alerts).padStart(2, '0')],
    ];
    // Rank first: it is the line a player looks for, and MGSV puts the grade at
    // the top of its results screen for the same reason. Only on a win — there
    // is no grade for dying, and printing "RANK C" under MISSION FAILED reads
    // as a consolation prize.
    if (rank && kind !== 'failed') meta.unshift(['RANK', String(rank).toUpperCase()]);
    if (because) meta.push([kind === 'failed' ? 'CAUSE' : 'RESULT', String(because).toUpperCase()]);
    this._show(
      kind,
      'Operation 51-J',
      kind === 'failed' ? 'Mission failed' : 'Mission accomplished',
      meta,
      [
        ['ENTER', 'RETRY'],
        ['ESC', 'MAIN MENU'],
      ],
    );
    // The end card holds until it is dismissed, not on a timer.
    this._t = -1;
    // The stinger is deliberately late — it lands with the type, after the
    // beat, not on the cut to black. See the header.
    this._beat = setTimeout(() => this.cue(`mission.${kind}`), 900);
  }

  /** Tear the card down immediately — used when leaving play. */
  clear() {
    this.running = false;
    this.result = null;
    this._card = null;
    this._t = -1;
    if (this._beat) clearTimeout(this._beat);
    this._beat = null;
    this.el.removeAttribute('data-card');
    this.el.removeAttribute('data-out');
  }

  countAlert() {
    this.alerts++;
  }

  update(dt) {
    if (this.running) this.elapsed += dt;

    // Fallback objective advance: real distance and real bodies, not a script.
    // Only while gameplay publishes no objective list of its own.
    if (this.running && this.src.objectives(this._scratch ?? (this._scratch = [])).length === 0) {
      const p = this.src.player();
      const d = Math.hypot(p.x - this.site.x, p.z - this.site.z);
      const [infil, clear, exfil] = this.fallback;
      if (!infil.done && d < 46) infil.done = true;
      if (!clear.done) {
        const g = this.src.garrison();
        clear.done = g.total > 0 && g.down >= Math.min(this.quota, g.total);
      }
      // Exfiltration is the win. It cannot complete before the other two, so
      // walking away at the start is not a mission, it is a retreat.
      if (infil.done && clear.done && !exfil.done && d > 120) {
        exfil.done = true;
        this.end('accomplished', 'exfiltrated under own power');
      }
    }

    // Mirror gameplay's own mission result if it publishes one.
    const state = this.src.mission();
    if (state && state !== this._lastMission) {
      this._lastMission = state;
      // Pass the CAUSE through, not just the status. Gameplay publishes why the
      // run ended and what it graded, and dropping it here is why a flawless
      // infiltration and a firefight printed an identical end card.
      if (state === 'accomplished' || state === 'failed') {
        const o = this.src.missionOutcome?.() ?? null;
        this.end(state, o?.reason ?? undefined, o?.rank ?? null);
      }
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
