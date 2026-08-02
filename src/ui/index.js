/**
 * ui module — the front end and the HUD.
 *
 * Everything is DOM/CSS inside `#ui` over the canvas. That is a deliberate
 * choice on a round whose whole point is frame time: a typographic UI in the
 * compositor costs zero GPU frame time and zero draw calls, and it is the only
 * way to get hairline rules and 0.4em tracking that stay crisp at any
 * resolution. Nothing in this directory allocates a texture, a material or a
 * render target.
 *
 * Layout of the module:
 *   style.js     the design system (read its header for the direction)
 *   dom.js       element factory + change-gated setters
 *   state.js     gameState resolution, harness guards, tolerant registry reads
 *   Menu.js      main menu + the slow backdrop orbit
 *   Settings.js  settings model, its side effects, and its panel
 *   Hud.js       alert / detection / compass / weapon / stance / damage
 *   Mission.js   title card, objectives, end cards
 *   Sim.js       a stand-in feed for review, off by default
 *
 * INPUT. `#ui` is `pointer-events: none` and only the menu's own controls opt
 * back in — and those live inside sections that are `visibility: hidden` outside
 * 'menu', which also makes them untargetable. So in godmode the UI cannot
 * swallow a click, which is what the screenshot harness and the free-fly camera
 * both need. The only global key this module claims is Escape.
 */

import { injectStyle } from './style.js';
import { el, attr } from './dom.js';
import { resolveGameState, guardHarness, makeAdapter } from './state.js';
import { Settings } from './Settings.js';
import { Menu } from './Menu.js';
import { Hud } from './Hud.js';
import { Mission } from './Mission.js';
import { Sim } from './Sim.js';

export async function install(world) {
  const host = document.getElementById('ui');
  if (!host) return null;

  injectStyle();

  const { gameState, isShim } = resolveGameState(world);
  let harnessDriving = false;

  const sim = new Sim(world);
  let demo = false;
  // The adapter reads the real registry unless demo mode is on, in which case it
  // reads the stand-in view. Nothing is ever written into world.registry.
  const src = makeAdapter(world, () => (demo ? sim.view() : world.registry));

  // --- sound cue hook -----------------------------------------------------
  // The UI names cues after what happened on screen; src/audio names them after
  // what it plays. This table is the join. A cue with no entry is still
  // broadcast to listeners and to the `ui:cue` event — it just makes no sound,
  // which is the right failure for a UI that must never depend on audio.
  const CUE_SOUND = {
    'alert.caution': 'alert.caution',
    'alert.alert': 'alert.spotted',
    'alert.evasion': 'alert.caution',
    'alert.calm': 'alert.clear',
    'mission.start': 'ui.missionstart',
    'mission.accomplished': 'ui.confirm',
    'mission.failed': 'ui.denied',
    'weapon.reload': 'weapon.reload',
    'weapon.empty': 'weapon.empty',
    'ui.move': 'ui.tick',
    'ui.back': 'ui.back',
  };
  const cueListeners = new Set();
  const cue = (name) => {
    const audio = world.registry.audio;
    if (audio && typeof audio.play === 'function') {
      try {
        audio.play(CUE_SOUND[name] ?? name);
      } catch (err) {
        console.warn('audio cue failed:', err);
      }
    }
    for (const fn of cueListeners) fn(name);
    window.dispatchEvent(new CustomEvent('ui:cue', { detail: name }));
  };

  // --- construction --------------------------------------------------------
  const settings = new Settings(world);
  const menu = new Menu(world, settings, gameState, () => harnessDriving);
  const hud = new Hud(world, src, cue);
  const mission = new Mission(world, src, cue);
  hud.setFallbackObjectives(mission.fallback);

  const frame = el('div.fr', null, [
    el('i.e-t'),
    el('i.e-r'),
    el('i.e-b'),
    el('i.e-l'),
    el('b.k-tl'),
    el('b.k-tr'),
    el('b.k-bl'),
    el('b.k-br'),
  ]);

  const root = el('div.ui', { 'data-mode': gameState.mode, 'data-panel': 'menu', 'data-alert': 'calm', 'data-boot': '1' });
  root.append(el('div.scrim'), frame, menu.el, settings.build(), hud.el, mission.el);
  host.appendChild(root);
  // The wound recolours the viewfinder frame, which is a sibling of the HUD.
  hud.root = root;

  const hide = () => {
    if (!root.hidden) root.hidden = true;
  };
  const show = () => {
    if (root.hidden && !harnessDriving) root.hidden = false;
  };

  // The harness owns the camera and the frame the moment it asks for anything.
  guardHarness(gameState, {
    hide,
    onDrive: () => {
      harnessDriving = true;
    },
  });

  // --- mode routing ---------------------------------------------------------
  const enter = (mode) => {
    attr(root, 'data-mode', mode);
    root.setAttribute('data-panel', 'menu');
    menu.panel = 'menu';
    if (mode === 'menu') {
      mission.clear();
      hud.reset();
      // offsetTop is 0 while the panel is hidden, so the caret can only be
      // placed once the menu is on screen again.
      requestAnimationFrame(() => menu.refresh());
    } else if (mode === 'play') {
      hud.reset();
      hud.measure();
      mission.start();
    } else {
      mission.clear();
    }
    // Only the shim owns freeFly. When src/main.js provides the real gameState
    // it owns the camera modes itself and this must not second-guess it.
    if (isShim && window.__GAME?.setFreeFly) {
      // 'play' has no player controller until src/gameplay lands; leaving the
      // free-fly rig on is the honest stand-in, and it costs one line to remove.
      window.__GAME.setFreeFly(mode !== 'menu');
    }
  };
  gameState.onModeChange(enter);

  // --- alert plumbing --------------------------------------------------------
  const applyAlert = (state) => {
    if (state === hud.alert) return;
    attr(root, 'data-alert', state);
    hud.setAlert(state);
    if (state === 'alert') mission.countAlert();
  };
  // `src/ai` is not in main.js's MODULES yet, so at install time there is
  // nothing to subscribe to. Try once now and again the first time the module
  // shows up; the per-frame read is the backstop either way, so the HUD is
  // correct whether the AI pushes or we pull.
  let alertSub = src.onAlertChange((state) => applyAlert(state));

  // --- damage and weapon events ---------------------------------------------
  // Guards firing is the only source of directional information the UI can
  // read today: `src/gameplay` resolves no damage on the player yet, so a shot
  // is drawn as a near miss (bone, fast) and a wedge only goes red when health
  // actually drops. When gameplay starts publishing health, the same code path
  // upgrades from "someone is shooting at me from there" to "I was hit from
  // there" without another wire.
  let fireSub = null;
  let eventSub = null;
  const subscribeFeeds = () => {
    if (!alertSub && world.registry.ai) alertSub = src.onAlertChange((state) => applyAlert(state));
    if (!fireSub) {
      fireSub = src.onGuardFire((ev) => {
        if (gameState.mode !== 'play' || harnessDriving) return;
        hud.incoming(ev, hud.health != null && hud.health < 0.999 ? 'hit' : 'near');
      });
    }
    if (!eventSub) {
      eventSub = src.onGameplayEvent((e) => {
        if (!e || gameState.mode !== 'play' || harnessDriving) return;
        // Damage the gameplay module resolves itself, with a source position.
        if (e.type === 'hurt' || e.type === 'damage' || e.type === 'hit') {
          hud.incoming(e.from ?? e.position ?? e.at ?? null, 'hit');
        } else if (e.type === 'reload') {
          cue('weapon.reload');
        } else if (e.type === 'empty' || e.type === 'dryFire') {
          cue('weapon.empty');
        }
      });
    }
  };
  const trySubscribe = subscribeFeeds;

  // --- the fail state --------------------------------------------------------
  // Health at zero ends the mission. This is the UI's own rule only until
  // gameplay publishes a mission result — `mission()` in the adapter takes
  // precedence the moment it returns one, and `Mission.end` is idempotent for
  // the run either way.
  const checkDown = () => {
    if (!mission.running || hud.health == null || hud.health > 0.001) return;
    mission.end('failed', 'killed in action');
  };
  let cardUp = false;

  // --- restart ---------------------------------------------------------------
  /**
   * Retry from an end card. The mode round trip is what actually restarts the
   * run: `src/gameplay` re-parks the player and resets the camera on
   * `modeEnter`, and this module clears the HUD and re-runs the title card on
   * the same signal. Anything that wants to reset further — the AI's alert
   * ladder, downed guards — gets the chance through its own reset hook first,
   * so this does not need to know what those are.
   */
  const restart = () => {
    for (const mod of [world.registry.ai, world.registry.gameplay, world.registry.player]) {
      for (const n of ['restart', 'reset']) {
        if (mod && typeof mod[n] === 'function') {
          try {
            mod[n]();
          } catch (err) {
            console.warn(`${n}() failed:`, err);
          }
          break;
        }
      }
    }
    mission.clear();
    gameState.setMode('menu');
    // One frame in the menu so every module's exit path runs before its entry
    // path. Re-entering play from inside the mode-change callback would have
    // gameplay tearing down the state it had just built.
    requestAnimationFrame(() => gameState.setMode('play'));
  };

  // --- keyboard ---------------------------------------------------------------
  const inSettings = () => root.getAttribute('data-panel') === 'settings';
  const onKey = (e) => {
    if (harnessDriving) return;
    const mode = gameState.mode;

    // An end card is a decision, and it owns the keyboard until it is made.
    if (mission.result && mode === 'play') {
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
        e.preventDefault();
        restart();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        gameState.setMode('menu');
      }
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      if (mode !== 'menu') gameState.setMode('menu');
      else if (inSettings()) {
        root.setAttribute('data-panel', 'menu');
        menu.closeSettings();
      }
      return;
    }
    if (mode !== 'menu') return;

    switch (e.code) {
      case 'ArrowUp':
        e.preventDefault();
        if (inSettings()) settings.focus(settings.sel - 1);
        else menu.focus(menu.sel - 1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (inSettings()) settings.focus(settings.sel + 1);
        else menu.focus(menu.sel + 1);
        break;
      case 'ArrowLeft':
        if (!inSettings()) break;
        e.preventDefault();
        settings.adjust(-1);
        break;
      case 'ArrowRight':
        if (!inSettings()) break;
        e.preventDefault();
        settings.adjust(1);
        break;
      case 'Enter':
      case 'Space':
        e.preventDefault();
        if (inSettings()) settings.activate();
        else {
          menu.activate();
          if (menu.panel === 'settings') root.setAttribute('data-panel', 'settings');
        }
        break;
      default:
        break;
    }
  };
  window.addEventListener('keydown', onKey);

  // Clicking SETTINGS goes through Menu.openSettings, which only flips its own
  // flag; the panel attribute lives here so there is one owner of the DOM state.
  menu.el.addEventListener('click', () => {
    if (menu.panel === 'settings') root.setAttribute('data-panel', 'settings');
  });

  // Persisted settings are inert until a human proves they are present — see the
  // header of Settings.js for why that matters to the screenshot harness.
  const armOnce = () => {
    settings.arm();
    // Same signal wakes the backdrop orbit for good — see Menu's `interacted`.
    menu.interacted = true;
    window.removeEventListener('pointerdown', armOnce);
    window.removeEventListener('pointermove', armOnce);
    window.removeEventListener('keydown', armOnce);
  };
  window.addEventListener('pointerdown', armOnce);
  window.addEventListener('pointermove', armOnce);
  window.addEventListener('keydown', armOnce);

  window.addEventListener('resize', () => hud.measure());

  // --- per-frame ---------------------------------------------------------------
  // order 2000: after the free-fly camera (1000) so the compass reads the pose
  // that is actually about to be drawn.
  world.engine.addSystem({
    order: 2000,
    update(dt, engine) {
      if (engine.deterministic) {
        harnessDriving = true;
        hide();
        return;
      }
      if (harnessDriving) return;
      show();

      const mode = gameState.mode;
      if (mode === 'menu') {
        menu.update(dt, engine, mode);
        return;
      }
      if (mode !== 'play') return;

      sim.update(dt);
      trySubscribe();
      const state = src.alert();
      if (state) applyAlert(state);
      mission.update(dt);
      hud.update(dt, engine);
      checkDown();

      // An end card is a decision, so hand the mouse back the moment one goes
      // up. Leaving the frame pointer-locked behind a card the player is
      // supposed to answer is the difference between a result screen and a
      // trap. Latched: exitPointerLock must not be called every frame.
      if (!!mission.result !== cardUp) {
        cardUp = !!mission.result;
        if (cardUp && document.pointerLockElement) document.exitPointerLock();
      }
    },
  });

  // The boot animation is one-shot; strip the flag so it cannot replay on a
  // later mode change.
  setTimeout(() => root.removeAttribute('data-boot'), 2200);
  requestAnimationFrame(() => {
    menu.refresh();
    hud.measure();
  });

  if (new URLSearchParams(location.search).has('uidemo')) demo = true;
  sim.setEnabled(demo);

  const api = {
    root,
    gameState,
    settings,
    menu,
    hud,
    mission,
    setMode: (m) => gameState.setMode(m),
    cue,
    onCue(fn) {
      cueListeners.add(fn);
      return () => cueListeners.delete(fn);
    },
    /** Force an alert phase — for the AI author to drive by hand while wiring up. */
    setAlert: applyAlert,
    /** Show an end card without a gameplay module. */
    endMission: (result, because) => mission.end(result, because),
    /** Retry the run, exactly as the end card's ENTER does. */
    restart,
    /** Directional damage from a world position: `__UI.damage({x, z})`. */
    damage: (from, kind) => hud.incoming(from, kind),
    /** What the adapter can currently see. The first thing to run when a readout is blank. */
    describe: () => src.describe(),
    /** Stand-in feed. See Sim.js. */
    demo(on = true) {
      demo = !!on;
      sim.setEnabled(demo);
    },
    hide,
    /** Un-latch the harness guard. Only ever called by hand from a probe. */
    show() {
      harnessDriving = false;
      root.hidden = false;
    },
  };
  window.__UI = api;
  return api;
}

// bench 1785616886161
