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
 */
export function guardHarness(gameState, { hide, onDrive }) {
  const g = window.__GAME;
  if (!g || g.__uiGuarded) return;
  g.__uiGuarded = true;

  const seize = () => {
    onDrive();
    hide();
    // The harness poses the camera itself; godmode is the mode that means
    // "nothing but the free-fly rig owns the camera", which is exactly right.
    if (gameState.mode !== 'godmode') gameState.setMode('godmode');
  };

  // Every tooling-only entry point on the harness API. A probe that measures,
  // poses or reads the frame will call at least one of these before it captures
  // anything, so the UI is gone by the time a pixel is read — including for a
  // probe that never touches applyShot.
  for (const name of ['applyShot', 'settle', 'stats', 'probeLuminance', 'setTimeOfDay']) {
    const fn = g[name];
    if (typeof fn !== 'function') continue;
    g[name] = function (...args) {
      seize();
      return fn.apply(this, args);
    };
  }
}

// --- tolerant registry reads ------------------------------------------------

/** First defined property from `names`, invoking it if it is a getter-ish fn. */
function pick(obj, names) {
  if (!obj) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v === undefined || v === null) continue;
    return typeof v === 'function' ? undefined : v;
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

const ALERT_STATES = ['calm', 'caution', 'alert', 'evasion'];

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
     * Everyone who might be looking at the player.
     * `[{ id, position:{x,y,z}, awareness:0..1, state }]`
     */
    sensors(out) {
      out.length = 0;
      const ai = source().ai;
      const list =
        pick(ai, ['sensors', 'contacts', 'guards', 'agents', 'enemies', 'units']) ??
        call(ai, ['getSensors', 'getContacts', 'getGuards']);
      if (!Array.isArray(list)) return out;
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (!g) continue;
        const p = vec(pick(g, ['position', 'pos', 'worldPosition'])) ?? (g.root && g.root.position) ?? (g.object3D && g.object3D.position);
        if (!p) continue;
        const a = pick(g, ['awareness', 'suspicion', 'detection', 'alertness', 'meter']);
        const aw = typeof a === 'number' ? Math.max(0, Math.min(1, a)) : 0;
        out.push({
          id: pick(g, ['id', 'uid', 'name']) ?? i,
          x: p.x,
          y: p.y,
          z: p.z,
          awareness: aw,
          state: aw >= 0.999 ? 'seen' : aw >= 0.55 ? 'alerted' : 'noticing',
        });
      }
      return out;
    },

    /** Player transform. Falls back to the camera so the compass always works. */
    player() {
      const gp = source().gameplay;
      const p = pick(gp, ['player', 'avatar', 'pc']);
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

    /** 0..1; 1 is untouched. MGSV has no health bar, only edge feedback. */
    health() {
      const gp = source().gameplay;
      const p = pick(gp, ['player', 'avatar', 'pc']);
      const h = pick(p, ['health', 'hp', 'life']) ?? pick(gp, ['health', 'hp']);
      if (typeof h !== 'number') return 1;
      const max = pick(p, ['maxHealth', 'healthMax']) ?? pick(gp, ['maxHealth']) ?? (h > 1 ? 100 : 1);
      return Math.max(0, Math.min(1, h / max));
    },

    stance() {
      const gp = source().gameplay;
      const p = pick(gp, ['player', 'avatar', 'pc']);
      const s = String(pick(p, ['stance', 'posture']) ?? pick(gp, ['stance']) ?? 'stand').toLowerCase();
      if (s.includes('prone') || s.includes('crawl')) return 'prone';
      if (s.includes('crouch') || s.includes('duck')) return 'crouch';
      return 'stand';
    },

    weapon() {
      const gp = source().gameplay;
      const p = pick(gp, ['player', 'avatar', 'pc']);
      const w = pick(p, ['weapon', 'equipped', 'gun']) ?? pick(gp, ['weapon']);
      if (!w) return null;
      return {
        name: String(pick(w, ['name', 'label', 'id']) ?? 'WEAPON').toUpperCase(),
        ammo: pick(w, ['ammo', 'magazine', 'mag', 'rounds']) ?? 0,
        reserve: pick(w, ['reserve', 'spare', 'pool', 'carried']) ?? 0,
        mode: String(pick(w, ['mode', 'fireMode', 'fire']) ?? '').toUpperCase(),
        suppressed: !!pick(w, ['suppressed', 'silenced', 'suppressor']),
      };
    },

    /** `[{ id, label, done, x, z }]`, current first. */
    objectives(out) {
      out.length = 0;
      const gp = source().gameplay;
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
      const gp = source().gameplay;
      const m = pick(gp, ['mission', 'missionState']) ?? gp;
      if (!m) return null;
      const raw = pick(m, ['status', 'state', 'result', 'outcome']);
      if (raw == null) return null;
      const s = String(raw).toLowerCase();
      if (s.includes('accompl') || s.includes('success') || s.includes('win') || s.includes('complete')) return 'accomplished';
      if (s.includes('fail') || s.includes('lose') || s.includes('dead')) return 'failed';
      if (s.includes('brief')) return 'briefing';
      return 'active';
    },

    missionName() {
      const gp = source().gameplay;
      const m = pick(gp, ['mission', 'missionState']) ?? gp;
      const n = pick(m, ['name', 'title', 'label']);
      return n ? String(n).toUpperCase() : null;
    },
  };
}
