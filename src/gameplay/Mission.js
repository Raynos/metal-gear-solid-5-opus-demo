import * as THREE from 'three';

/**
 * Mission — the reason to play: an objective, a win and a loss.
 *
 * `src/ui/Mission.js` already draws the MGSV title card and both end cards, and
 * it already looks for all of this on `registry.gameplay`; until now it found
 * nothing, fell back to a hard-coded list, and could never show an end card
 * because no module ever declared a result. This publishes the real thing, in
 * exactly the shape the UI's adapter probes for:
 *
 *   gameplay.mission     { name, status, elapsed, alerts, reason }
 *   gameplay.objectives  [{ id, label, done, position }]
 *
 * `status` is 'briefing' | 'active' | 'accomplished' | 'failed'.
 *
 * THE COMMANDER is designated by src/ai, which is being written in parallel, so
 * he is resolved by search rather than by import and re-searched until he turns
 * up: any guard whose role/flag says commander, or a character carrying the
 * same mark. In a tree where nobody has designated one yet the objective falls
 * back to the whole garrison, so the mission is still winnable — a win state
 * that depends on another author's landing is not a win state.
 */

const COMMANDER_KEYS = ['commander', 'officer', 'leader', 'captain'];

/** Distance from the compound centre that counts as "inside the wire". */
const INFIL_RADIUS = 46;

function looksLikeCommander(o) {
  if (!o) return false;
  if (o.isCommander || o.commander === true) return true;
  const role = String(o.role ?? o.rank ?? o.kind ?? '').toLowerCase();
  return COMMANDER_KEYS.some((k) => role.includes(k));
}

/** Is this man out of the fight? Both modules' spellings are accepted. */
function isDown(o) {
  if (!o) return false;
  return !!(o.downed || o.down || o.dead || o.ch?.downed || o.ch?.down);
}

export class MissionState {
  /**
   * @param {object} opts
   *   registry   world.registry — ai and outpost are read lazily, never cached
   *   controller PlayerController
   *   events     gameplay event bus
   *   spawn      {x, z} the insertion point, used as the exfil marker
   */
  constructor({ registry, controller, events, spawn }) {
    this.registry = registry;
    this.ctl = controller;
    this.events = events;

    const b = registry.outpost?.bounds;
    this.site = b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    this.spawn = new THREE.Vector3(spawn?.x ?? 0, 0, spawn?.z ?? 0);

    this.name = 'INFILTRATE THE OUTPOST';
    this.status = 'briefing';
    this.elapsed = 0;
    this.alerts = 0;
    this.reason = null;
    this.commander = null;

    this.objectives = [
      { id: 'infil', label: 'INFILTRATE THE OUTPOST', done: false, position: this.site },
      { id: 'neutralise', label: 'NEUTRALISE THE COMMANDER', done: false, position: this.site },
    ];
    this._findT = 0;
    this._unsubAlert = null;
  }

  /** Called on entering play. */
  begin() {
    this.status = 'active';
    this.elapsed = 0;
    this.alerts = 0;
    this.reason = null;
    for (const o of this.objectives) o.done = false;
    this._watchAlerts();
    this.events?.emit({ type: 'missionStart', name: this.name });
  }

  /** Called on leaving play. Nothing here survives a mode change. */
  stop() {
    this.status = 'briefing';
    if (this._unsubAlert) { this._unsubAlert(); this._unsubAlert = null; }
  }

  _watchAlerts() {
    if (this._unsubAlert) return;
    const ai = this.registry.ai;
    if (typeof ai?.onAlertChange !== 'function') return;
    this._unsubAlert = ai.onAlertChange((e) => {
      const to = String(e?.to ?? e ?? '').toUpperCase();
      if (to === 'ALERT') this.alerts++;
    }) ?? null;
  }

  /**
   * The commander, or null. Re-run at 2 Hz until he is found: src/ai may
   * designate him after install, and a one-shot lookup at boot would decide
   * for the whole run that there is nobody to kill.
   */
  _resolveCommander(dt) {
    if (this.commander) return this.commander;
    this._findT -= dt;
    if (this._findT > 0) return null;
    this._findT = 0.5;
    const ai = this.registry.ai;
    const direct = ai?.commander ?? (typeof ai?.getCommander === 'function' ? ai.getCommander() : null);
    // TAKE THE LIVE ENTITY, NEVER THE DESCRIPTOR.
    //
    // `registry.ai.commander` is a GETTER that builds a fresh
    // `{ guard, character, position, down }` on every read. Storing that object
    // stores a SNAPSHOT of `down` — taken at resolve time, when it is always
    // false — and since this method returns early once `this.commander` is set,
    // it is never re-read. Measured: the commander was shot, `ai.commanderDown`
    // went true, `characters.commander.downed` went true, and the mission sat
    // at `active` for the full 60 s of the probe. Reaching for `.ch` first (its
    // old spelling) missed, because the descriptor spells it `.character`.
    let found = direct?.character ?? direct?.ch ?? direct ?? null;
    if (!found) {
      for (const g of ai?.guards ?? []) {
        if (looksLikeCommander(g) || looksLikeCommander(g.ch)) { found = g.ch ?? g; break; }
      }
    }
    if (!found) {
      for (const ch of this.registry.characters?.characters ?? []) {
        if (looksLikeCommander(ch)) { found = ch; break; }
      }
    }
    if (found) {
      this.commander = found;
      this.objectives[1].position = found.position;
      this.events?.emit({ type: 'commanderFound', target: found });
    }
    return found;
  }

  /** Fallback win condition where nobody has been designated: the garrison. */
  _garrisonDown() {
    const list = this.registry.ai?.guards ?? this.registry.characters?.characters ?? [];
    let live = 0;
    for (const g of list) {
      if (g.ch?.isPlayer || g.isPlayer) continue;
      if (!isDown(g)) live++;
    }
    return list.length > 0 && live === 0;
  }

  update(dt) {
    if (this.status !== 'active') return;
    this.elapsed += dt;
    this._watchAlerts();

    const p = this.ctl.position;
    const infil = this.objectives[0];
    if (!infil.done && Math.hypot(p.x - this.site.x, p.z - this.site.z) < INFIL_RADIUS) {
      infil.done = true;
      this.events?.emit({ type: 'objective', id: infil.id });
    }

    const cmd = this._resolveCommander(dt);
    const neutralise = this.objectives[1];
    if (!neutralise.done) {
      if (cmd) {
        neutralise.label = 'NEUTRALISE THE COMMANDER';
        // Ask the module that owns him as well as the entity itself. `down` and
        // `downed` are two modules' spellings of the same fact and either one
        // going true is the win; requiring both is how a win state stays
        // unreachable while every part of it works.
        if (isDown(cmd) || this.registry.ai?.commanderDown) this.accomplish('commander');
      } else {
        // Nobody designated. Say so honestly rather than pointing the player at
        // a marker over an empty patch of sand.
        neutralise.label = 'NEUTRALISE THE GARRISON';
        neutralise.position = this.site;
        if (this._garrisonDown()) this.accomplish('garrison');
      }
    }
  }

  accomplish(reason = 'objective') {
    if (this.status !== 'active') return;
    this.objectives[1].done = true;
    this.status = 'accomplished';
    this.reason = reason;
    this.events?.emit({ type: 'missionEnd', result: 'accomplished', reason, elapsed: this.elapsed });
  }

  fail(reason = 'killed') {
    if (this.status !== 'active') return;
    this.status = 'failed';
    this.reason = reason;
    this.events?.emit({ type: 'missionEnd', result: 'failed', reason, elapsed: this.elapsed });
  }

  /**
   * What `registry.gameplay.mission` exposes. Mutated in place rather than
   * rebuilt: the HUD reads it at 30 Hz and so does the mission card.
   */
  get view() {
    const v = this._view ?? (this._view = {});
    v.name = this.name;
    v.status = this.status;
    v.elapsed = +this.elapsed.toFixed(2);
    v.alerts = this.alerts;
    v.reason = this.reason;
    return v;
  }
}
