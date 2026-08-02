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
 *   gameplay.mission     { name, status, elapsed, alerts, reason, seen, rank }
 *   gameplay.objectives  [{ id, label, done, position }]
 *
 * `status` is 'briefing' | 'active' | 'accomplished' | 'failed'.
 *
 * ROUND 11 — THE MISSION HAS A SHAPE NOW. A human played round 10 and said
 * "mission accomplished is so lacklustre — I randomly shoot a guard and I'm
 * done", and he was right about every word of it. Three separate faults:
 *
 *   THE WIN WAS ONE EVENT. `accomplish()` fired the instant the commander went
 *   down, from any range, standing still. A stealth mission whose last beat is
 *   a trigger pull has no exit, no consequence and nothing to lose on the way
 *   out. There is a third objective now — EXFILTRATE — and it is the win. The
 *   rule already existed, fully written, at src/ui/Mission.js:189: it refuses
 *   to complete before the earlier objectives, so leaving at the start is a
 *   retreat rather than a victory. But that whole block is gated on gameplay
 *   publishing NO objectives, and gameplay publishes two, so it has been dead
 *   code since round 8. It is moved here, where it runs.
 *
 *   INFIL TICKED OUTSIDE THE WIRE. A fixed 46 m radius about the compound
 *   centre, which on the built outpost is beyond the perimeter — "INFILTRATE
 *   THE OUTPOST" completed while the player was still walking up the track.
 *   `registry.outpost.isInside(x, z)` is the perimeter polygon the module that
 *   owns the compound publishes for exactly this; the radius is only a fallback
 *   for a tree with no outpost, and it is derived from the bounds rather than
 *   guessed.
 *
 *   BEING SEEN COST NOTHING. `alerts` was incremented and then read once, to
 *   print ALERTS 00 on the end card. It is now a graded result — see `rank`
 *   below — and src/ai hardens the commander on the same signal.
 *
 * THE COMMANDER is designated by src/ai, so he is resolved by search rather
 * than by import and re-searched until he turns up: any guard whose role/flag
 * says commander, or a character carrying the same mark. In a tree where nobody
 * has designated one yet the objective falls back to the whole garrison, so the
 * mission is still winnable — a win state that depends on another author's
 * landing is not a win state.
 */

const COMMANDER_KEYS = ['commander', 'officer', 'leader', 'captain'];

/**
 * Fallback "inside the wire" test, used only when the outpost publishes no
 * perimeter. Derived from the compound's own bounds — 0.55 of the half-span is
 * comfortably inside a rectangular perimeter and outside nothing.
 */
const INFIL_FRACTION = 0.55;
/** Absolute floor for the exfil range, in metres from the compound centre. */
const EXFIL_MIN = 100;
/**
 * How far short of the insertion point the exfil ring sits. The marker is the
 * spawn, so the ring has to be inside it or walking back to the marker would
 * leave the player standing on the boundary waiting for float noise.
 */
const EXFIL_MARGIN = 10;

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
   *   spawn      {x, z} the insertion point, and the exfil marker
   */
  constructor({ registry, controller, events, spawn }) {
    this.registry = registry;
    this.ctl = controller;
    this.events = events;

    const outpost = registry.outpost ?? registry.outpostGround ?? null;
    const b = outpost?.bounds;
    this.site = b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    this.spawn = new THREE.Vector3(spawn?.x ?? 0, spawn?.y ?? 0, spawn?.z ?? 0);

    // The perimeter, if the compound publishes one. Bound once so a probe can
    // see which test is actually in use rather than inferring it.
    this.perimeter = typeof outpost?.isInside === 'function'
      ? (x, z) => outpost.isInside(x, z)
      : null;
    this.infilRadius = b
      ? Math.max(12, Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 * INFIL_FRACTION)
      : 30;

    // Out past where you came in. Derived from the insertion point rather than
    // hard-coded: Spawn.js chooses that range from the garrison's sight range,
    // so an exfil ring inside it would let the player win from inside their
    // vision cones.
    const spawnDist = Math.hypot(this.spawn.x - this.site.x, this.spawn.z - this.site.z);
    this.exfilRange = Math.max(EXFIL_MIN, spawnDist - EXFIL_MARGIN);

    this.name = 'INFILTRATE THE OUTPOST';
    this.status = 'briefing';
    this.elapsed = 0;
    this.alerts = 0;
    /** True once any guard has ever had a positive ID on the player. */
    this.seen = false;
    /** True once any guard's meter passed SUSPECT — he came to look. */
    this.noticed = false;
    this.reason = null;
    this.commander = null;
    /** Mission clock at the moment the commander went down, or null. */
    this.killedAt = null;

    this.objectives = [
      { id: 'infil', label: 'INFILTRATE THE OUTPOST', done: false, position: this.site },
      { id: 'neutralise', label: 'NEUTRALISE THE COMMANDER', done: false, position: this.site },
      // The exfil marker is the insertion point: the player walks back out the
      // way he came in, which is also the only part of the approach he has
      // already scouted.
      { id: 'exfil', label: `EXFILTRATE — ${Math.round(this.exfilRange)} M`, done: false, position: this.spawn },
    ];
    this._findT = 0;
    this._unsubAlert = null;
  }

  /** Called on entering play. */
  begin() {
    this.status = 'active';
    this.elapsed = 0;
    this.alerts = 0;
    this.seen = false;
    this.noticed = false;
    this.reason = null;
    this.killedAt = null;
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
      if (to !== 'ALERT') return;
      this.alerts++;
      // Going loud is proof they know you are here, whatever the meter says a
      // frame later — a rank that forgives it because the detection decayed
      // before the next sample is not a rank.
      this.seen = true;
      this.events?.emit({ type: 'alert', count: this.alerts, at: this.elapsed });
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

  /** Inside the wire — the compound's own perimeter when it publishes one. */
  inside(x, z) {
    if (this.perimeter) return !!this.perimeter(x, z);
    return Math.hypot(x - this.site.x, z - this.site.z) < this.infilRadius;
  }

  update(dt) {
    if (this.status !== 'active') return;
    this.elapsed += dt;
    this._watchAlerts();

    // A positive ID is a fact about the run whether or not it became an alert:
    // a guard who identified you, walked over and lost you still identified
    // you. `detection().awareness` is already normalised against AWARE.DETECT,
    // so 1 is exactly that and nothing weaker.
    //
    // NOT `detection().seeing`. That is `vis.visible` — geometrically in range,
    // inside the 120-degree cone, line of sight clear — which is true of a
    // prone man in shadow at 70 m whose meter never moves. It is the input to
    // the detection model, not its verdict; ranking on it would make S
    // unreachable by design.
    const det = this.registry.ai?.detection?.();
    if (det) {
      if (det.awareness >= 0.999) this.seen = true;
      // One rung down: a guard broke off and came to look. Not a spot, but not
      // a clean run either — published so the HUD/end card can say so.
      if (det.awareness >= 0.66) this.noticed = true;
    }

    const p = this.ctl.position;
    const dSite = Math.hypot(p.x - this.site.x, p.z - this.site.z);
    const [infil, neutralise, exfil] = this.objectives;

    if (!infil.done && this.inside(p.x, p.z)) {
      infil.done = true;
      this.events?.emit({ type: 'objective', id: infil.id });
    }

    const cmd = this._resolveCommander(dt);
    if (!neutralise.done) {
      if (cmd) {
        neutralise.label = 'NEUTRALISE THE COMMANDER';
        neutralise.position = cmd.position ?? this.site;
        // Ask the module that owns him as well as the entity itself. `down` and
        // `downed` are two modules' spellings of the same fact and either one
        // going true is the objective; requiring both is how a win state stays
        // unreachable while every part of it works.
        if (isDown(cmd) || this.registry.ai?.commanderDown) {
          neutralise.done = true;
          this.killedAt = +this.elapsed.toFixed(2);
          this.events?.emit({ type: 'objective', id: neutralise.id, at: this.killedAt });
        }
      } else {
        // Nobody designated. Say so honestly rather than pointing the player at
        // a marker over an empty patch of sand.
        neutralise.label = 'NEUTRALISE THE GARRISON';
        neutralise.position = this.site;
        if (this._garrisonDown()) {
          neutralise.done = true;
          this.killedAt = +this.elapsed.toFixed(2);
          this.events?.emit({ type: 'objective', id: neutralise.id, at: this.killedAt });
        }
      }
    }

    // EXFILTRATION IS THE WIN, and it is the only thing that is. It cannot
    // complete before the other two, so walking away at the start is a retreat
    // rather than a mission, and killing the commander from 400 m and standing
    // still is a shot rather than an ending.
    if (!exfil.done && infil.done && neutralise.done && dSite > this.exfilRange) {
      exfil.done = true;
      this.accomplish('exfiltrated under own power');
    }
  }

  accomplish(reason = 'objective') {
    if (this.status !== 'active') return;
    this.objectives[2].done = true;
    this.status = 'accomplished';
    this.reason = reason;
    this.events?.emit({
      type: 'missionEnd', result: 'accomplished', reason, elapsed: this.elapsed, rank: this.rank,
    });
  }

  fail(reason = 'killed') {
    if (this.status !== 'active') return;
    this.status = 'failed';
    this.reason = reason;
    this.events?.emit({ type: 'missionEnd', result: 'failed', reason, elapsed: this.elapsed });
  }

  /**
   * The run, graded. Three inputs and no hidden ones: were you ever seen, how
   * many times did the compound go loud, and how long did it take.
   *
   *   S  never seen at all, and out inside eight minutes
   *   A  never seen — the meter never filled and it never went loud
   *   B  seen, but the garrison never went to ALERT more than once
   *   C  anything else
   *
   * The time gate only separates S from A. Ranking primarily on the clock
   * rewards running in and shooting, which is the exact thing the human's note
   * was about.
   */
  get rank() {
    if (!this.seen && this.alerts === 0) return this.elapsed <= 480 ? 'S' : 'A';
    if (this.alerts === 0) return 'A';
    if (this.alerts <= 1) return 'B';
    return 'C';
  }

  /** One line for the end card: `A · 04:12 · 1 ALERT · SPOTTED`. */
  get summary() {
    const m = Math.floor(this.elapsed / 60);
    const s = Math.floor(this.elapsed % 60);
    const clock = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const alerts = this.alerts === 0 ? 'NO ALERTS' : `${this.alerts} ALERT${this.alerts === 1 ? '' : 'S'}`;
    return `${this.rank} · ${clock} · ${alerts} · ${this.seen ? 'SPOTTED' : 'NEVER SEEN'}`;
  }

  /**
   * What `registry.gameplay.mission` exposes. Mutated in place rather than
   * rebuilt: the HUD reads it at 30 Hz and so does the mission card.
   *
   * `rank`, `seen`, `summary` and `killedAt` are additive. `src/ui/Mission.js`
   * calls `end(result)` with no second argument, so the end card still shows
   * only TIME and ALERTS — the grade is published and waiting for the one line
   * over there that reads it. See the note in this round's commit.
   */
  get view() {
    const v = this._view ?? (this._view = {});
    v.name = this.name;
    v.status = this.status;
    v.elapsed = +this.elapsed.toFixed(2);
    v.alerts = this.alerts;
    v.seen = this.seen;
    v.noticed = this.noticed;
    v.reason = this.reason;
    v.rank = this.rank;
    v.summary = this.summary;
    v.killedAt = this.killedAt;
    v.exfilRange = +this.exfilRange.toFixed(1);
    return v;
  }
}
