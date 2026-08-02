import { clamp } from './dsp.js';
import { AudioEngine } from './AudioEngine.js';
import { Ambience } from './Ambience.js';
import { Foley } from './Foley.js';
import { Music } from './Music.js';
import { Alert, normalisePhase } from './Alert.js';
import { UiSounds } from './UiSounds.js';

/**
 * audio — everything you hear, synthesised. No files, no fetches, no deps.
 *
 * ## The rule that shapes this module
 *
 * The screenshot harness is the project's measuring instrument. It runs headless
 * and muted, it forces `godmode`, and it must be completely unaffected by audio
 * existing. So:
 *
 *   - The AudioContext is created **only** by `arm()`, and `arm()` refuses
 *     unless a *trusted* input event has been seen. Measured inside a real
 *     shot: a direct `arm()` returns false, a dispatched (untrusted)
 *     `pointerdown` returns false, and ctxState stays `'none'` through a full
 *     boot. See the comment on `userGesture` for two guards that looked correct
 *     and were not.
 *   - Until armed, the per-frame system costs one boolean test — measured at
 *     0.02-0.04 us per frame, i.e. nothing. Armed and running in play mode with
 *     a moving camera and 20 live voices it costs 6.6 us, which is 0.04% of a
 *     16.7 ms frame; the DSP itself runs on the browser's audio thread and
 *     never touches the render thread at all.
 *   - This module adds nothing to the scene graph: no meshes, no materials, no
 *     textures. Draw calls and triangle counts are unchanged by construction.
 *   - In `godmode` the master is faded out and the context is suspended, so the
 *     free-fly camera the harness drives is silent even in a real browser.
 *   - Every path into WebAudio is guarded; with no audio device the module
 *     reports `available: false` and every call becomes a no-op.
 *
 * ## Public API — `world.registry.audio`
 *
 * Other modules should not reach into the classes; call these:
 *
 *   arm()                          start the context (from a click handler)
 *   setEnabled(bool)               force the bus on/off (mode changes do this)
 *   setMasterVolume(0..1)
 *   play(name, opts)               string dispatch, see NAMES below
 *   footstep({stance,surface,pos,level})
 *   cloth({level,pos}) / weapon(kind,pos) / tranq(pos) / cqc(kind,pos)
 *   setAlert(phaseOrLevel)         'calm'|'suspicious'|'caution'|'evasion'|'alert'
 *                                  or a 0..1 number
 *   setWind(0..1)
 *   ui.tick() / ui.confirm() / ui.back() / ui.denied() / ui.missionStart()
 *   stats()                        voices, drops, phase — for probes
 *
 * Nothing above throws if audio never started; they all return quietly.
 *
 * ## What it listens to
 *
 *   world.gameState.onModeChange   enable/disable per mode
 *   world.registry.ai.onAlertChange the stings and the score's intensity
 *   world.registry.gameplay        stance / noiseLevel / position, and event
 *                                  hooks if it exposes any (late-bound: this
 *                                  module installs last but other modules may
 *                                  populate their handles after boot)
 */

/** Modes in which the bus is live. `godmode` is silent by contract. */
const AUDIBLE_MODES = new Set(['menu', 'play']);

const STANCE_ALIAS = {
  stand: 'walk',
  standing: 'walk',
  idle: 'walk',
  walk: 'walk',
  walking: 'walk',
  run: 'run',
  running: 'run',
  jog: 'run',
  sprint: 'sprint',
  sprinting: 'sprint',
  crouch: 'crouch',
  crouching: 'crouch',
  crouched: 'crouch',
  prone: 'prone',
  crawl: 'prone',
};

export async function install(world) {
  const { engine, registry } = world;

  const eng = new AudioEngine();
  const music = new Music(eng);
  const ambience = new Ambience(eng, world);
  const foley = new Foley(eng, world);
  const alert = new Alert(eng, music);
  const ui = new UiSounds(eng);

  let mode = world.gameState?.mode ?? 'menu';
  let wantEnabled = AUDIBLE_MODES.has(mode);
  const unsubs = [];

  /** Push the enable state down to every subsystem in one place. */
  function applyEnabled() {
    const on = wantEnabled && eng.armed;
    eng.setEnabled(on);
    ambience.setEnabled(on && !!eng.ctx);
    music.setEnabled(on && !!eng.ctx);
    // Foley is gameplay only — the menu backdrop has no player.
    foley.setEnabled(on && mode === 'play');
    alert.setEnabled(on && mode === 'play');
  }

  function setMode(next) {
    if (!next || next === mode) return;
    mode = next;
    wantEnabled = AUDIBLE_MODES.has(mode);
    applyEnabled();
    if (mode === 'play') music.setIntensity(0.0, 3.0);
  }

  // --- arming ------------------------------------------------------------
  /**
   * Set by a *trusted* input event and never by anything else. This is the
   * whole safety property of this module: no gesture, no AudioContext, and the
   * screenshot harness never makes a gesture.
   *
   * Two other candidate gates were tried and rejected:
   *
   *   `engine.deterministic` is only raised inside settle(), so it is false for
   *   the entire boot — measured: an arm() call from install() succeeded and
   *   left ctxState 'running' inside a real shot. It is kept below as a second
   *   check, but it cannot be the primary one.
   *
   *   `navigator.userActivation.hasBeenActive` looks perfect and is not:
   *   measured **true** in chrome-headless-shell during a shot, with no input
   *   of any kind. Trusting it would have been a guard that reads as airtight
   *   in review and does nothing at runtime, which is worse than no guard.
   */
  let userGesture = false;

  function arm() {
    if (eng.armed) return false;
    if (!userGesture) return false; // never armed by code, only by a person
    if (engine.deterministic) return false; // the harness is driving
    if (!wantEnabled) return false;
    if (!eng.arm()) return false;
    applyEnabled();
    return true;
  }

  const onGesture = (e) => {
    if (e && e.isTrusted === false) return; // synthetic events are not consent
    userGesture = true;
    if (arm()) {
      for (const [t, fn] of gestureEvents) window.removeEventListener(t, fn, true);
    }
  };
  const gestureEvents = [
    ['pointerdown', onGesture],
    ['keydown', onGesture],
    ['touchstart', onGesture],
  ];
  // Capture phase, deliberately: the UI's own click handler may call
  // `audio.arm()`, and window-level bubble listeners run *after* it. Capturing
  // means `userGesture` is already set by the time any element handler runs.
  for (const [t, fn] of gestureEvents) window.addEventListener(t, fn, { passive: true, capture: true });

  // A backgrounded tab should not keep a synth running.
  const onVisibility = () => {
    if (!eng.ctx) return;
    if (document.hidden) eng.ctx.suspend().catch(() => {});
    else if (eng.enabled) eng.ctx.resume().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVisibility);

  // --- mode --------------------------------------------------------------
  if (world.gameState?.onModeChange) {
    const u = world.gameState.onModeChange((m) => setMode(typeof m === 'string' ? m : m?.mode));
    if (typeof u === 'function') unsubs.push(u);
  }

  // --- late binding to AI and gameplay -----------------------------------
  // This module installs last, but a handle can still be published after boot
  // (a module that builds on its first tick, for instance). Poll at 2 Hz for
  // 20 s, then give up. Costs nothing once bound.
  let bindAi = false;
  let bindPlay = false;
  let bindTimer = 0;
  let bindLeft = 20;
  /** False once gameplay emits its own footstep events. */
  let derive = true;

  const normStance = (s) => STANCE_ALIAS[String(s ?? '').toLowerCase()] ?? 'walk';

  function tryBind() {
    if (!bindAi) {
      const ai = registry.ai;
      const sub = ai?.onAlertChange;
      if (typeof sub === 'function') {
        // `e.to` FIRST, and that is a bug fix, not a preference. src/ai emits
        // `{from, to, reason, position}` — no `phase`, no `state`, no `level` —
        // so `normalisePhase(e)` found nothing it recognised, returned null,
        // and `Alert.set` returned on its first line. Measured: three real
        // squad transitions produced three calls into `set` and zero stings and
        // zero changes of musical intensity. The score sat at 0 for the whole
        // mission. `normalisePhase` now knows `to` as well, so this is belt and
        // braces; passing it explicitly is what makes the intent readable.
        const u = sub.call(ai, (e) => alert.set(e?.to ?? e));
        if (typeof u === 'function') unsubs.push(u);
        bindAi = true;
      } else if (ai?.events?.on) {
        ai.events.on('alert', (e) => alert.set(e?.to ?? e));
        bindAi = true;
      }
    }
    if (!bindPlay) {
      const gp = registry.gameplay;
      if (gp) {
        // If gameplay emits its own step events, prefer them and stop deriving
        // steps from movement — its animation knows exactly when a foot lands.
        if (typeof gp.onFootstep === 'function') {
          const u = gp.onFootstep((e) => {
            // Resolve the surface HERE when the publisher does not name one.
            // Passing `undefined` through fell back to Foley's own default of
            // sand, so adopting a gameplay-published footstep would have made
            // every step in the compound sound like open desert — a silent
            // regression that only shows up the moment somebody implements
            // this hook. Four surfaces exist; ask which one this is.
            const pos = e?.position ?? null;
            let surface = e?.surface;
            if (!surface) surface = pos ? foley.surfaceAt(pos.x, pos.z) : undefined;
            foley.footstep({
              stance: normStance(e?.stance ?? readPlayer()?.stance),
              surface,
              // Own feet are ON the listener; a panner at the player's own
              // position puts them at zero distance and the pan model gets
              // unstable. Foley's stereo-offset path is the right one.
              pos: null,
              level: e?.level ?? 1,
            });
          });
          if (typeof u === 'function') unsubs.push(u);
          derive = false;
        }
        if (typeof gp.onEvent === 'function') {
          const u = gp.onEvent((name, data) => api.play(String(name), data));
          if (typeof u === 'function') unsubs.push(u);
        }
        bindPlay = true;
      }
    }
    return bindAi && bindPlay;
  }

  /**
   * Resolve the player however the game happens to expose one. Gameplay owns
   * the real answer; characters is the fallback so footsteps work the moment a
   * controller exists, whichever module ends up owning it.
   */
  function readPlayer() {
    const gp = registry.gameplay;
    const p = gp?.player ?? gp?.state?.player ?? gp?.state ?? registry.characters?.player;
    if (!p?.position) return null;
    const stanceRaw = p.stance ?? p.anim?.stance ?? gp?.stance;
    return {
      position: p.position,
      stance: normStance(stanceRaw === 'stand' && (p.speed ?? gp?.speed ?? 0) > 3.2 ? 'run' : stanceRaw),
      noiseLevel: p.noiseLevel ?? gp?.noiseLevel,
      surface: p.surface ?? gp?.surface,
    };
  }

  // --- wind --------------------------------------------------------------
  // The ambience follows the same wind vector the vegetation sways to, so a
  // gust you can see in the grass is a gust you hear.
  let windAcc = 0;
  function pollWind() {
    const u = registry.vegetation?.uniforms?.uWind?.value;
    // uWind is (dirX, dirZ, strength, _); strength ~0.22 at the tuned default,
    // which is a moderate breeze — map it so 0.22 reads as a little over half.
    const s = u ? clamp(u.z * 2.6, 0, 1) : 0.55;
    ambience.setWind(s);
  }
  pollWind();

  // --- per-frame ---------------------------------------------------------
  engine.addSystem({
    // After every camera system (free-fly is 1000) so the listener is placed
    // from this frame's pose, not the previous one's.
    order: 1500,
    update(dt, e) {
      if (!eng.armed) return; // the harness never gets past this line
      eng.update(e.camera);
      if (!eng.running) return;

      // `resume()` is async, so the context is usually still 'suspended' on the
      // frame `arm()` ran. The beds are built on the first frame it is actually
      // running instead — building into a suspended context silently produces
      // sources that never start.
      if (!music.built || !ambience.built) applyEnabled();

      if (bindLeft > 0 && !(bindAi && bindPlay)) {
        bindTimer -= dt;
        if (bindTimer <= 0) {
          bindTimer = 0.5;
          bindLeft -= 0.5;
          tryBind();
        }
      }

      windAcc += dt;
      if (windAcc > 0.5) {
        windAcc = 0;
        pollWind();
      }

      ambience.update(dt, e.camera);
      music.update();
      if (derive && mode === 'play') foley.update(dt, readPlayer());
    },
  });

  // --- public API --------------------------------------------------------
  const NAMES = {
    'ui.tick': () => ui.tick(),
    'ui.confirm': () => ui.confirm(),
    'ui.back': () => ui.back(),
    'ui.denied': () => ui.denied(),
    'ui.missionstart': () => ui.missionStart(),
    'player.footstep': (o) => foley.footstep(o ?? {}),
    'player.cloth': (o) => foley.cloth(o ?? {}),
    'weapon.click': (o) => foley.weapon('click', o?.pos ?? o ?? null),
    'weapon.reload': (o) => foley.weapon('reload', o?.pos ?? o ?? null),
    'weapon.draw': (o) => foley.weapon('draw', o?.pos ?? o ?? null),
    'weapon.holster': (o) => foley.weapon('holster', o?.pos ?? o ?? null),
    'weapon.empty': (o) => foley.weapon('empty', o?.pos ?? o ?? null),
    'weapon.tranq': (o) => foley.tranq(o?.pos ?? o ?? null),
    /** An UNsuppressed rifle — the garrison's, never the player's. */
    'weapon.shot': (o) => foley.gunshot(o?.pos ?? o ?? null),
    'cqc.hit': (o) => foley.cqc('hit', o?.pos ?? o ?? null),
    'cqc.grab': (o) => foley.cqc('grab', o?.pos ?? o ?? null),
    'cqc.throw': (o) => foley.cqc('throw', o?.pos ?? o ?? null),
    'cqc.knife': (o) => foley.cqc('knife', o?.pos ?? o ?? null),
    'alert.spotted': () => alert.spotted(),
    'alert.caution': () => alert.caution(),
    'alert.clear': () => alert.clear(),
  };

  const api = {
    engine: eng,
    ambience,
    foley,
    music,
    alert,
    ui: {
      tick: () => ui.tick(),
      confirm: () => ui.confirm(),
      back: () => ui.back(),
      denied: () => ui.denied(),
      missionStart: () => ui.missionStart(),
    },
    get available() {
      return eng.available;
    },
    get ready() {
      return eng.running;
    },
    get mode() {
      return mode;
    },
    arm,
    setMode, // for callers with no gameState wired up
    setEnabled(on) {
      wantEnabled = !!on;
      applyEnabled();
    },
    setMasterVolume: (v) => eng.setMasterVolume(v),
    play(name, opts) {
      const fn = NAMES[String(name).toLowerCase()];
      if (fn) fn(opts);
      return !!fn;
    },
    footstep: (o) => foley.footstep(o ?? {}),
    cloth: (o) => foley.cloth(o ?? {}),
    weapon: (kind, pos) => foley.weapon(kind, pos),
    tranq: (pos) => foley.tranq(pos),
    gunshot: (pos) => foley.gunshot(pos),
    cqc: (kind, pos) => foley.cqc(kind, pos),
    setAlert: (p) => alert.set(p),
    setAlertLevel: (v) => alert.setLevel(v),
    setWind: (v) => ambience.setWind(v),
    normalisePhase,
    /**
     * Render every cue through an OfflineAudioContext and measure it.
     *
     * A DYNAMIC import, so `_selftest.js` is a separate chunk that the boot
     * path never fetches — it costs nothing until a probe asks for it. It used
     * to require hand-editing this file to run at all, which meant in practice
     * that nobody ran it, and "does this cue make a signal" is the one question
     * a headless muted machine cannot answer any other way.
     */
    selftest: () => import('./_selftest.js').then((m) => m.run()),
    stats: () => ({
      available: eng.available,
      armed: eng.armed,
      running: eng.running,
      mode,
      phase: alert.phase,
      intensity: music.target,
      wind: ambience.wind,
      gust: +ambience.gust.toFixed(3),
      voices: eng.stats.voices,
      peakVoices: eng.stats.peakVoices,
      dropped: eng.stats.dropped,
      ctxState: eng.ctx?.state ?? 'none',
    }),
    dispose() {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* the publisher's problem, not ours */
        }
      }
      for (const [t, fn] of gestureEvents) window.removeEventListener(t, fn);
      document.removeEventListener('visibilitychange', onVisibility);
      eng.dispose();
    },
  };

  tryBind();
  if (typeof window !== 'undefined') window.__AUDIO = api;
  return api;
}
