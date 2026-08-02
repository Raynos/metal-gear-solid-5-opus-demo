/**
 * state.js — how the UI talks to everything it does not own.
 *
 * Three jobs, all of them defensive:
 *
 * 1. GAME STATE. `src/main.js` owns `world.gameState` ('menu' | 'godmode' |
 *    'play'). If it is there we use it and never write to main.js. If it is not
 *    — this UI landed in a tree where the three-mode seam has not been merged
 *    yet — we publish a compatible shim so the front end still works, and step
 *    aside the moment the real one exists.
 *
 * 2. THE HARNESS IS SOVEREIGN. `tools/shotd.mjs` takes a FULL-PAGE screenshot
 *    (`page.screenshot()`), not a canvas capture, so a DOM overlay lands in
 *    every canonical shot and every visual-regression diff in this project. The
 *    UI must therefore be provably invisible whenever the harness is driving.
 *    Three independent guards, because one is not enough for something that can
 *    silently corrupt seven reference frames:
 *      a) `applyShot()` is wrapped and hides the UI synchronously, before the
 *         harness has a chance to render or capture.
 *      b) `settle()` is wrapped the same way.
 *      c) a per-frame check on `engine.deterministic` hides it anyway.
 *    Once any of these fires, `harnessDriving` latches true for the life of the
 *    page and the menu's backdrop camera never touches `engine.camera` again.
 *
 * 3. TOLERANT READS of `registry.ai` / `registry.gameplay`. Those modules are
 *    being written in parallel and their shapes are not settled. Every read goes
 *    through a probe that accepts several plausible names and falls back
 *    cleanly, so a rename over there degrades this to "no data" rather than to
 *    a page error — and a page error here fails every screenshot in the repo.
 *
 * WHY THE WEAPON BLOCK WAS BLANK FOR SEVEN ROUNDS. Tolerance is not the same as
 * correctness. Every player read went through `registry.gameplay`, and
 * `src/gameplay` publishes `registry.player` — so `weapon()` returned null,
 * `stance()` returned the 'stand' default and `health()` returned the 1
 * default, for ever, silently, with no error anywhere. Defensive code that
 * cannot tell "absent" from "wrong name" hides its own bugs. Two changes
 * follow from that:
 *
 *   - `resolvePlayer()` is one function that knows every place the avatar has
 *     actually lived, and it is the ONLY way anything here reaches the player.
 *   - reads that have no meaningful default return `null`, not a default.
 *     `health()` returning 1 when nothing publishes health is a lie the damage
 *     vignette cannot distinguish from full health. It returns null now.
 *
 * `describe()` dumps what was found and what was not, so the next author can
 * see the seam from a probe instead of inferring it from a blank widget.
 */

const MODES = ['menu', 'godmode', 'play'];

/**
 * Resolve `world.gameState`, creating a shim if `src/main.js` has not published
 * one. Returns `{ gameState, isShim }`.
 */
export function resolveGameState(world) {
  const existing = world.gameState;
  if (existing && typeof existing.setMode === 'function' && typeof existing.onModeChange === 'function') {
    return { gameState: existing, isShim: false };
  }

  const listeners = new Set();
  const gs = {
    mode: 'menu',
    setMode(m) {
      if (!MODES.includes(m)) throw new Error(`unknown mode: ${m}`);
      if (m === gs.mode) return;
      const prev = gs.mode;
      gs.mode = m;
      for (const fn of [...listeners]) {
        try {
          fn(m, prev);
        } catch (err) {
          console.error('onModeChange listener threw:', err);
        }
      }
    },
    onModeChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  world.gameState = gs;
  return { gameState: gs, isShim: true };
}

/**
 * Wrap the harness entry points so the UI is guaranteed to be gone before a
 * capture. `hide` is called synchronously inside the wrapper; `onDrive` latches
 * the caller's own state.
 *
 * TWO TIERS, AND THE SPLIT IS THE WHOLE POINT.
 *
 * This used to force `godmode` from all five entry points, and that made play
 * mode unmeasurable. A probe would `setMode('play')`, call `settle(24)` to warm
 * the frame — and the settle threw it straight back into godmode, with
 * `registry.gameplay.active === false` and the camera returned to the shot pose.
 * Every play-mode frame time this project has ever quoted was therefore a
 * godmode frame time, with depth of field and motion blur in the wrong state.
 * The capability check that should have caught it passed because godmode turns
 * `freeFly` on, so holding KeyW still moved *a* camera.
 *
 *   applyShot()  POSES THE CAMERA. It is the only one that may force a mode: a
 *                play or menu camera still running would fight it for the pose
 *                on the next frame, which is the real requirement this guard
 *                exists to serve.
 *   everything   only observes. It must still HIDE the UI — the harness takes
 *   else         a full-page screenshot, so a DOM overlay would land in every
 *                reference frame — but hiding a DOM node cannot disturb a
 *                measurement, and changing the mode plainly can.
 *
 * `__GAME.raw.*` holds the unwrapped originals for a harness that wants no
 * opinion from the UI at all.
 */
export function guardHarness(gameState, { hide, onDrive }) {
  const g = window.__GAME;
  if (!g || g.__uiGuarded) return;
  g.__uiGuarded = true;

  const raw = (g.raw ??= {});

  /** Screenshot safety only. Never touches the mode. */
  const conceal = () => {
    onDrive();
    hide();
  };
  /** Screenshot safety AND camera ownership, for the one call that poses. */
  const seize = () => {
    conceal();
    if (gameState.mode !== 'godmode') gameState.setMode('godmode');
  };

  const wrap = (name, before) => {
    const fn = g[name];
    if (typeof fn !== 'function') return;
    raw[name] = fn;
    g[name] = function (...args) {
      before();
      return fn.apply(this, args);
    };
  };

  wrap('applyShot', seize);
  for (const name of ['settle', 'stats', 'probeLuminance', 'setTimeOfDay']) wrap(name, conceal);
}

// --- tolerant registry reads ------------------------------------------------

/**
 * First defined, non-function property from `names`.
 *
 * The `continue` on a function is load-bearing and was a `return undefined` for
 * nine rounds. `registry.ai` publishes a METHOD called `contacts()` and an
 * ARRAY called `guards`, and `sensors()` probes for `['sensors', 'contacts',
 * 'guards', ...]` in that order. Bailing out on the method meant the probe
 * never reached `guards`, so the detection ring — the core feedback loop of the
 * entire genre — drew nothing at all, in every build, silently. A name that
 * happens to hold a function is not an answer; it is a name that did not match.
 */
function pick(obj, names) {
  if (!obj) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v === undefined || v === null || typeof v === 'function') continue;
    return v;
  }
  return undefined;
}

function call(obj, names, ...args) {
  if (!obj) return undefined;
  for (const n of names) {
    if (typeof obj[n] === 'function') {
      try {
        return obj[n](...args);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The signals the HUD needs off the player, and what each one is worth. */
const PLAYER_SIGNALS = [
  ['weapon', 'equipped', 'gun', 'loadout'],
  ['ammo', 'rounds', 'inMag'],
  ['health', 'hp', 'life', 'vitality'],
  ['stance', 'posture'],
  ['position', 'pos'],
];

/**
 * Where the player avatar lives — resolved by WHAT AN OBJECT CARRIES, not by
 * what it is called.
 *
 * Naming is not enough, and this is the trap that ate the weapon widget. In
 * this build there are three plausible candidates and the two obvious ones are
 * both wrong:
 *
 *   registry.gameplay.player   the CHARACTER. Has position and stance, so it
 *                              passes every "does it look like a player" test,
 *                              and has no weapon, no ammo and no health.
 *   registry.gameplay          === registry.player; the module's API object.
 *   registry.player            the API object: ammo, stance, position, events.
 *
 * A resolver that takes the first thing named `player` picks the character,
 * finds no weapon, and returns null for ever — silently, because "no weapon
 * equipped" is a legitimate answer. So every candidate is scored by how many
 * of the signals above it actually has, and the richest wins. Ties go to the
 * earlier candidate, which keeps the stand-in feed in Sim.js ahead of the real
 * registry when demo mode is on.
 */
export function resolvePlayer(reg) {
  if (!reg) return null;
  const gp = reg.gameplay ?? null;
  const candidates = [pick(gp, ['player', 'avatar', 'pc']), reg.player, gp];
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    let score = 0;
    for (const names of PLAYER_SIGNALS) if (pick(c, names) !== undefined) score++;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Whatever is holding mission status: `registry.mission`, or the gameplay module. */
function resolveMission(reg) {
  if (!reg) return null;
  return reg.mission ?? pick(reg.gameplay, ['mission', 'missionState']) ?? reg.gameplay ?? reg.player ?? null;
}

const ALERT_STATES = ['calm', 'caution', 'alert', 'evasion'];

/**
 * The AI's own awareness thresholds — see `AWARE` in src/ai/perception.js.
 * Duplicated rather than imported: src/ui importing src/ai would make the HUD
 * fail to boot in a tree where the AI module is absent, which is exactly the
 * failure mode everything else in this file exists to prevent. Read from the
 * live module when it offers them.
 */
const AWARE_FALLBACK = { NOTICE: 0.3, SUSPECT: 0.66, DETECT: 1.0 };

/**
 * `src/gameplay/Vitals.js`'s health model, duplicated for the same reason and
 * with the same rule: read the live value when gameplay offers one.
 *   REGEN_DELAY   seconds of not being shot before health starts coming back
 *   ROUND_DAMAGE  what one rifle round costs — the unit the vitals comb counts in
 */
const REGEN_DELAY_FALLBACK = 4.0;
const ROUND_DAMAGE_FALLBACK = 0.16;

/**
 * Short mono tag naming WHY a guard's meter is moving.
 *
 * `src/ai` publishes exactly four `awareReason` values — 'sight', 'sound',
 * 'body', 'contact' — plus null once the meter leaks below 0.02. That enum is
 * the authority; the guard's `state` is only consulted when we are reading a
 * raw Guard rather than a `contacts()` record, because a guard walking over to
 * look ('investigate') has already lost the reason that sent him.
 */
const REASON_TAG = {
  sight: 'SIGHT',
  sound: 'NOISE',
  body: 'BODY',
  contact: 'CONTACT',
};

function reasonOf(g, visible, awareness) {
  const published = pick(g, ['reason', 'awareReason']);
  if (published) return REASON_TAG[String(published).toLowerCase()] ?? String(published).toUpperCase();
  const state = String(pick(g, ['state', 'mode', 'behaviour']) ?? '').toLowerCase();
  if (visible) return 'SIGHT';
  if (state === 'combat') return 'CONTACT';
  if (state === 'search' || state === 'investigate' || state === 'inspect') return 'SEARCH';
  if (state === 'scan') return 'NOISE';
  if (state === 'radio') return 'RADIO';
  return awareness > 0 ? 'LOST' : '';
}

/** Coerce whatever the AI module calls its alert phase into our four states. */
export function normaliseAlert(raw) {
  if (raw == null) return 'calm';
  const s = String(raw).toLowerCase();
  if (ALERT_STATES.includes(s)) return s;
  if (s.includes('evas') || s.includes('search') || s.includes('lost')) return 'evasion';
  if (s.includes('alert') || s.includes('combat') || s.includes('engage')) return 'alert';
  if (s.includes('caution') || s.includes('suspic') || s.includes('invest')) return 'caution';
  return 'calm';
}

/**
 * A stable read-only view over `registry.ai` and `registry.gameplay`, whatever
 * shape they end up with. Every accessor returns a sensible empty value when
 * the module is not installed.
 */
export function makeAdapter(world, source = () => world.registry) {
  const tmp = { x: 0, y: 0, z: 0 };
  /** Last awareness per guard, so a fill rate exists even if the AI publishes none. */
  const _prevAware = new Map();
  let _rateT = 0;

  const vec = (v) => {
    if (!v) return null;
    if (typeof v.x === 'number') return v;
    if (Array.isArray(v) && v.length >= 3) {
      tmp.x = v[0];
      tmp.y = v[1];
      tmp.z = v[2];
      return tmp;
    }
    return null;
  };

  return {
    get ai() {
      return source().ai ?? null;
    },
    get gameplay() {
      return source().gameplay ?? null;
    },

    /** 'calm' | 'caution' | 'alert' | 'evasion' */
    alert() {
      const ai = source().ai;
      if (!ai) return null;
      const raw = pick(ai, ['alert', 'alertLevel', 'alertState', 'phase', 'state']) ?? call(ai, ['getAlert', 'getAlertLevel']);
      return raw == null ? null : normaliseAlert(raw);
    },

    /** Subscribe to alert changes if the AI module offers it. */
    onAlertChange(fn) {
      const ai = source().ai;
      if (!ai) return null;
      for (const n of ['onAlertChange', 'onAlert', 'onAlertLevelChange']) {
        if (typeof ai[n] === 'function') {
          const off = ai[n]((...a) => fn(normaliseAlert(a[0]), a[0]));
          return typeof off === 'function' ? off : () => {};
        }
      }
      return null;
    },

    /**
     * Everyone who might be looking at the player, quietest first is NOT
     * guaranteed — the HUD sorts. Downed men are dropped: a body is not a
     * sensor, and leaving him on the ring is the difference between a HUD that
     * teaches the game and one that punishes you for a takedown that worked.
     *
     * `contacts()` FIRST. `src/ai` publishes a method whose own comment calls it
     * "the shape a renderer could ask for" — flat `{id, role, state, down, x, y,
     * z, awareness, reason, seeing, dist, suppressed, reloading, commander}`,
     * with awareness already normalised against AWARE.DETECT. Reading raw
     * `guards` instead means re-deriving all of that from a 62-field simulation
     * object, which is how `reason` used to be guessed from `state`.
     *
     * What `contacts()` does NOT carry is the two things a map needs — where a
     * man is LOOKING and how far he can see — plus the meter's fill rate. Those
     * live on the raw `Guard` (`lookYaw`, `vis.range`, `vis.rate`), so the two
     * are joined by id. The join is optional in both directions: no `guards`
     * array still yields a full detection ring, just without cones.
     *
     * `[{ id, x, y, z, awareness, tier, reason, rate, dist, visible, seeing,
     *    yaw, range, role, commander }]`
     *   tier   'seen' | 'alerted' | 'noticing' | 'trace', at the AI's thresholds
     *   reason SIGHT | NOISE | BODY | CONTACT | SEARCH | RADIO | LOST
     *   rate   how fast the meter is filling, 1/s — drives the urgency pulse
     *   yaw    head bearing in radians, 0 = -Z, or null
     *   range  effective sight range in metres (stance/alert/night), or null
     */
    sensors(out) {
      out.length = 0;
      const ai = source().ai;
      const list =
        call(ai, ['contacts', 'getSensors', 'getContacts', 'getGuards']) ??
        pick(ai, ['sensors', 'contacts', 'guards', 'agents', 'enemies', 'units']);
      if (!Array.isArray(list)) return out;

      // The raw simulation objects, for the fields contacts() leaves out.
      const raw = pick(ai, ['guards', 'agents', 'units']);
      const rawById = new Map();
      if (Array.isArray(raw)) for (const g of raw) if (g) rawById.set(pick(g, ['id', 'uid']) ?? g, g);

      const A = pick(ai, ['AWARE', 'thresholds']) ?? AWARE_FALLBACK;
      const notice = typeof A.NOTICE === 'number' ? A.NOTICE : AWARE_FALLBACK.NOTICE;
      const suspect = typeof A.SUSPECT === 'number' ? A.SUSPECT : AWARE_FALLBACK.SUSPECT;
      const now = performance.now() / 1000;
      const dt = _rateT ? Math.min(0.5, now - _rateT) : 0;
      _rateT = now;

      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (!g) continue;
        if (pick(g, ['down', 'downed', 'dead', 'incapacitated']) === true) continue;
        const id = pick(g, ['id', 'uid', 'name']) ?? i;
        const sim = rawById.get(id) ?? (g.ch ? g : null);

        // contacts() is flat x/y/z; a raw Guard hides position behind `ch`.
        const p =
          typeof g.x === 'number'
            ? g
            : vec(pick(g, ['position', 'pos', 'worldPosition'])) ??
              (g.ch && g.ch.position) ??
              (g.root && g.root.position);
        if (!p) continue;

        const a = pick(g, ['awareness', 'suspicion', 'detection', 'alertness', 'meter']);
        const aw = typeof a === 'number' ? Math.max(0, Math.min(1, a)) : 0;

        const vis = pick(sim, ['vis', 'vision', 'sight']) ?? pick(g, ['vis']) ?? null;
        const visible = !!(pick(g, ['seeing', 'sees', 'visible']) ?? pick(vis, ['visible', 'sees', 'los']));

        // The AI's own fill rate when it publishes one. Otherwise difference the
        // meter ourselves — the urgency pulse is the only pre-completion warning
        // the player gets, and it must not depend on a field that may be absent.
        let rate = pick(vis, ['rate', 'gain']) ?? pick(g, ['rate']);
        if (typeof rate !== 'number' || !Number.isFinite(rate)) {
          const prev = _prevAware.get(id);
          rate = dt > 0 && typeof prev === 'number' ? (aw - prev) / dt : 0;
        }
        _prevAware.set(id, aw);

        const d = pick(g, ['dist', 'distance']) ?? pick(vis, ['dist', 'distance']);
        const yaw = pick(sim, ['lookYaw']) ?? pick(sim, ['yaw']) ?? pick(g, ['lookYaw', 'yaw']);
        const range = pick(vis, ['range']);

        out.push({
          id,
          x: p.x,
          y: p.y,
          z: p.z,
          awareness: aw,
          tier: aw >= 0.999 ? 'seen' : aw >= suspect ? 'alerted' : aw >= notice ? 'noticing' : 'trace',
          reason: reasonOf(g, visible, aw),
          rate: typeof rate === 'number' && Number.isFinite(rate) ? rate : 0,
          dist: typeof d === 'number' && Number.isFinite(d) ? d : null,
          visible,
          /** He has line of sight RIGHT NOW — distinct from "he saw you once". */
          seeing: visible,
          yaw: typeof yaw === 'number' && Number.isFinite(yaw) ? yaw : null,
          range: typeof range === 'number' && Number.isFinite(range) && range > 0 ? range : null,
          role: pick(g, ['role']) ?? null,
          commander: pick(g, ['commander']) === true || pick(g, ['role']) === 'commander',
        });
      }
      // Men who left the list must not keep a stale meter reading behind them.
      if (_prevAware.size > out.length * 4 + 32) _prevAware.clear();
      return out;
    },

    /**
     * The one-line summary of what the garrison knows, straight off the AI's
     * own `detection()`. `{ level, awareness, reason, by, dist, seeing }` — the
     * peak meter across the whole outpost, which is the number that answers
     * "how close am I to being made" without reading six markers.
     */
    detection() {
      const d = call(source().ai, ['detection']);
      if (!d || typeof d !== 'object') return null;
      return {
        level: normaliseAlert(d.level),
        awareness: typeof d.awareness === 'number' ? Math.max(0, Math.min(1, d.awareness)) : 0,
        reason: d.reason ? REASON_TAG[String(d.reason).toLowerCase()] ?? String(d.reason).toUpperCase() : '',
        by: d.by ?? null,
        dist: typeof d.dist === 'number' && Number.isFinite(d.dist) ? d.dist : null,
        /** How many men have eyes on the player this instant. */
        seeing: typeof d.seeing === 'number' ? d.seeing : 0,
      };
    },

    /** The avatar object itself, wherever gameplay decided to publish it. */
    playerObject() {
      return resolvePlayer(source());
    },

    /**
     * `{ total, down }` for the garrison. The fallback mission is scored off
     * this and nothing else, so a win condition exists without inventing a
     * commander who is not in the world.
     */
    garrison() {
      const ai = source().ai;
      const list = pick(ai, ['guards', 'agents', 'units']) ?? call(ai, ['getGuards']);
      if (!Array.isArray(list)) return { total: 0, down: 0 };
      let down = 0;
      for (const g of list) if (g && pick(g, ['down', 'downed', 'dead', 'incapacitated']) === true) down++;
      return { total: list.length, down };
    },

    /** Player transform. Falls back to the camera so the compass always works. */
    player() {
      const p = resolvePlayer(source());
      const pos = p ? vec(pick(p, ['position', 'pos'])) ?? (p.root && p.root.position) : null;
      if (pos) {
        const yaw = pick(p, ['yaw', 'heading']) ?? (p.root ? p.root.rotation.y : 0);
        return { x: pos.x, y: pos.y, z: pos.z, yaw, real: true };
      }
      const cam = world.engine.camera;
      // atan2 of the camera's forward vector; -Z is forward in three.js.
      const e = cam.rotation;
      return { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: e.y, real: false };
    },

    /**
     * 0..1, or NULL when nothing publishes health. Null is the honest answer
     * and the caller must handle it: a default of 1 is indistinguishable from
     * "untouched", which is how the damage vignette spent six rounds wired to
     * a constant.
     */
    health() {
      const p = resolvePlayer(source());
      const h = pick(p, ['health', 'hp', 'life', 'vitality']);
      if (typeof h !== 'number' || !Number.isFinite(h)) return null;
      const max = pick(p, ['maxHealth', 'healthMax', 'hpMax']) ?? (h > 1 ? 100 : 1);
      return Math.max(0, Math.min(1, h / max));
    },

    /**
     * The wound in full, or null when nothing publishes health.
     *
     * `{ health, segments, regen, sinceHit, dead, shock }`
     *
     * REGENERATION IS DERIVED, and it has to be: `src/gameplay/Vitals.js` runs
     * MGSV's model — nothing comes back for REGEN_DELAY seconds after the last
     * round, then it refills over about seven — but publishes no `regenerating`
     * flag. What it does publish is `vitals.sinceHit`, and the delay is the
     * whole decision in that model: it is the difference between "break contact
     * now and you live" and "you are already dead". So the HUD reads
     * `sinceHit > REGEN_DELAY && health < 1` and shows the two states apart.
     *
     * The delay is duplicated here rather than imported for the same reason the
     * awareness thresholds are — see AWARE_FALLBACK. If gameplay ever publishes
     * it, `regenDelay` is preferred over the constant.
     */
    vitals() {
      const p = resolvePlayer(source());
      const h = this.health();
      if (h == null) return null;
      const v = pick(p, ['vitals']) ?? p;
      const sinceHit = pick(v, ['sinceHit', 'timeSinceHit']);
      const delay = pick(v, ['regenDelay', 'REGEN_DELAY']) ?? REGEN_DELAY_FALLBACK;
      const since = typeof sinceHit === 'number' && Number.isFinite(sinceHit) ? sinceHit : null;
      return {
        health: h,
        /**
         * How many rifle rounds you can take. `ROUND_DAMAGE` is 0.16, so the
         * comb is drawn in the unit the player actually loses health in — the
         * answer to "am I about to die" is a count of hits, not a percentage.
         * Six segments of 0.167 against a round's 0.16 drifts by a quarter of a
         * segment over a whole magazine, which is well inside the width of a
         * tick and keeps the comb even.
         */
        segments: Math.round(1 / ROUND_DAMAGE_FALLBACK),
        regen: h < 0.999 && since != null && since > delay,
        sinceHit: since,
        regenDelay: delay,
        /** Seconds until regeneration starts, or 0 once it has. */
        untilRegen: since == null ? null : Math.max(0, delay - since),
        dead: pick(p, ['dead']) === true || h <= 0.001,
        shock: typeof pick(p, ['shock']) === 'number' ? pick(p, ['shock']) : 0,
      };
    },

    /**
     * Static outpost layout for the map, read ONCE — none of it moves.
     * `{ bounds:{minX,minZ,maxX,maxZ}, centre:{x,z}, isInside, gate }` or null.
     */
    outpost() {
      const o = source().outpost ?? source().outpostGround;
      const b = pick(o, ['bounds']);
      if (!b || !b.min || !b.max) return null;
      const gate = vec(pick(o, ['gate']));
      return {
        bounds: { minX: b.min.x, minZ: b.min.z, maxX: b.max.x, maxZ: b.max.z },
        centre: { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2 },
        /** The only perimeter test src/world/outpost publishes. */
        isInside: typeof o.isInside === 'function' ? (x, z) => o.isInside(x, z) : null,
        gate: gate ? { x: gate.x, z: gate.z } : null,
      };
    },

    stance() {
      const p = resolvePlayer(source());
      const s = String(pick(p, ['stance', 'posture']) ?? 'stand').toLowerCase();
      if (s.includes('prone') || s.includes('crawl')) return 'prone';
      if (s.includes('crouch') || s.includes('duck')) return 'crouch';
      return 'stand';
    },

    /**
     * The equipped weapon, or null.
     *
     * Two shapes are accepted, and the second one is why the widget appears at
     * all in this build. The AGREED shape is a descriptor object on the player:
     *
     *   player.weapon = { name, kind, ammo, magSize, reserve, mode,
     *                     suppressed, reloading }
     *
     * Round 8's `src/gameplay` publishes no such object — it exposes `ammo` and
     * `reloading` directly on the player API. Rather than draw nothing until
     * both sides land, the flat form is read too and the missing fields are
     * left null for the HUD to render as absent. `magSize` in particular is
     * inferred by the HUD from the highest magazine count it has seen, which is
     * exact from the first full magazine onward.
     */
    weapon() {
      const p = resolvePlayer(source());
      if (!p) return null;
      const w = pick(p, ['weapon', 'equipped', 'gun', 'loadout']) ?? null;
      const src = w ?? p;
      const ammo = pick(src, ['ammo', 'rounds', 'inMag', 'magazine']);
      // No descriptor AND no round count means nothing is equipped, as far as
      // this UI can tell. Draw nothing rather than empty chrome.
      if (!w && typeof ammo !== 'number') return null;

      const rawReload = pick(src, ['reloading', 'reload', 'reloadT']);
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      // With no descriptor at all we are reading round 8's flat player API, and
      // that weapon is not a guess: src/gameplay/Stealth.js fires a
      // tranquilliser dart, suppressed, and nothing else exists to equip.
      const kind = String(pick(src, ['kind', 'type', 'class']) ?? (w ? '' : 'tranq')).toLowerCase();

      return {
        name: String(pick(src, ['name', 'label', 'displayName', 'id']) ?? (kind === 'tranq' ? 'tranq pistol' : kind || 'weapon')).toUpperCase(),
        kind,
        ammo: num(ammo) ?? 0,
        magSize: num(pick(src, ['magSize', 'magCapacity', 'capacity', 'clipSize', 'magazineSize'])),
        reserve: num(pick(src, ['reserve', 'spare', 'pool', 'carried', 'stock'])),
        mode: String(pick(src, ['mode', 'fireMode', 'fire']) ?? '').toUpperCase(),
        // Suppressed unless told otherwise for a tranquilliser: a dart pistol
        // that announces itself is not the weapon this game is built around.
        suppressed: pick(src, ['suppressed', 'silenced', 'suppressor']) ?? kind.includes('tranq'),
        /** true while reloading; `reloadLeft` is seconds when gameplay says so. */
        reloading: rawReload === true || (typeof rawReload === 'number' && rawReload > 0),
        reloadLeft: num(rawReload),
        /** 0..1 of suppressor life left, or null for "fitted, no reading". */
        supLife: num(pick(src, ['supLife', 'suppressorLife', 'suppressorWear', 'supWear'])),
      };
    },

    /** `[{ id, label, done, x, z }]`, current first. */
    objectives(out) {
      out.length = 0;
      const reg = source();
      const gp = reg.mission ?? reg.gameplay ?? reg.player;
      const list = pick(gp, ['objectives', 'tasks', 'goals']) ?? call(gp, ['getObjectives']);
      if (!Array.isArray(list)) return out;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (!o) continue;
        const p = vec(pick(o, ['position', 'pos', 'at']));
        out.push({
          id: pick(o, ['id', 'key']) ?? i,
          label: String(pick(o, ['label', 'text', 'title', 'name']) ?? '').toUpperCase(),
          done: !!pick(o, ['done', 'complete', 'completed']),
          x: p ? p.x : null,
          z: p ? p.z : null,
        });
      }
      return out;
    },

    /** 'briefing' | 'active' | 'accomplished' | 'failed' | null */
    mission() {
      const m = resolveMission(source());
      if (!m) return null;
      const raw = pick(m, ['missionStatus', 'missionResult', 'status', 'result', 'outcome']);
      if (raw == null) return null;
      const s = String(raw).toLowerCase();
      if (s.includes('accompl') || s.includes('success') || s.includes('win') || s.includes('complete')) return 'accomplished';
      if (s.includes('fail') || s.includes('lose') || s.includes('dead')) return 'failed';
      if (s.includes('brief')) return 'briefing';
      return 'active';
    },

    missionName() {
      const reg = source();
      const m = reg.mission ?? pick(reg.gameplay, ['mission', 'missionState']);
      const n = pick(m, ['name', 'title', 'label']);
      return n ? String(n).toUpperCase() : null;
    },

    /**
     * Subscribe to gameplay's own event bus if it has one. Round 8's
     * `src/gameplay` emits { type: 'reload' | 'shot' | 'tranq' | 'takedown' |
     *  'grab' | 'drag' | 'stow' | 'cover' | 'hurt' | ... }, which is how the
     * weapon block learns about a reload the same frame it starts rather than
     * inferring it from a count that has not moved yet.
     * Returns an unsubscribe, or null when there is no bus.
     */
    onGameplayEvent(fn) {
      const reg = source();
      const bus = reg.events ?? pick(reg.gameplay, ['events']) ?? pick(reg.player, ['events']);
      if (!bus) return null;
      for (const n of ['on', 'subscribe', 'addListener']) {
        if (typeof bus[n] === 'function') {
          const off = bus[n](fn);
          return typeof off === 'function' ? off : () => {};
        }
      }
      return null;
    },

    /** Whenever a guard pulls the trigger: `{ guard, from:{x,y,z}, dist }`. */
    onGuardFire(fn) {
      const ai = source().ai;
      if (!ai || typeof ai.onGuardFire !== 'function') return null;
      const off = ai.onGuardFire((ev) => {
        const from = vec(ev && ev.from);
        if (!from) return;
        fn({ x: from.x, y: from.y, z: from.z, dist: typeof ev.dist === 'number' ? ev.dist : null });
      });
      return typeof off === 'function' ? off : () => {};
    },

    /**
     * What this adapter can actually see right now. Purely diagnostic — run it
     * from a probe when a readout is blank, instead of guessing which side of
     * the seam is broken.
     */
    describe() {
      const reg = source();
      const p = resolvePlayer(reg);
      const via = !p ? null : p === reg.player ? 'registry.player' : p === reg.gameplay ? 'registry.gameplay' : 'gameplay.player';
      return {
        registryKeys: Object.keys(reg ?? {}),
        playerFoundVia: via,
        playerSignals: p ? PLAYER_SIGNALS.filter((n) => pick(p, n) !== undefined).map((n) => n[0]) : [],
        weapon: this.weapon(),
        health: this.health(),
        stance: p ? this.stance() : null,
        alert: this.alert(),
        sensors: this.sensors([]).length,
        sensorSample: this.sensors([])[0] ?? null,
        detection: this.detection(),
        vitals: this.vitals(),
        outpost: this.outpost(),
        mission: this.mission(),
      };
    },
  };
}
