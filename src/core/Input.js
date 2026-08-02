/**
 * Input — one rebindable action map for keyboard, mouse and gamepad.
 *
 * Every consumer asks for an ACTION ("sprint", "crouch", "fire"), never for a
 * key code. That is not tidiness for its own sake: the same action has to be
 * reachable from three devices at once (W / left stick, Shift / L3, LMB / R2),
 * and a controller that reads `KeyW` in six places cannot be rebound, cannot be
 * driven by a pad, and cannot be replayed by a test.
 *
 * Ownership of the keyboard is EXCLUSIVE and mode-scoped. `src/main.js` runs a
 * free-fly camera off its own window listeners for 'godmode' — which is what the
 * screenshot harness drives — so this manager stays fully detached until the
 * game asks for it, and detaching means listeners removed, not a flag checked.
 * Two systems both consuming WASD is how a harness pose starts drifting between
 * runs.
 *
 * Source syntax (a binding is a list of these, any of which fires the action):
 *   'KeyW', 'ShiftLeft', ...   KeyboardEvent.code
 *   'Mouse0' | 'Mouse1' | 'Mouse2'
 *   'WheelUp' | 'WheelDown'
 *   'Pad0' .. 'Pad17'          gamepad button index
 *   'Axis2+' | 'Axis2-'        gamepad axis past ±AXIS_BUTTON
 */

const AXIS_DEAD = 0.18;      // stick deadzone; below this an axis reads exactly 0
const AXIS_BUTTON = 0.55;    // where an axis starts counting as a button press
const TRIGGER_ON = 0.35;     // analog trigger -> digital

/**
 * The default map. MGSV on a keyboard, near enough that muscle memory carries.
 *
 * EVERY ACTION HAS A KEYBOARD BINDING. This is played on laptops with a
 * trackpad, where holding a two-finger right-click while steering with the same
 * hand is not something a person can actually do. Mouse buttons stay as the
 * primary for anyone who has a mouse; the keyboard alternative is not a
 * fallback, it is a first-class path:
 *
 *   aim   right-mouse  or  E
 *   fire  left-mouse   or  Space
 *
 * Arrow keys are look, not movement — on a trackpad, turning is the thing you
 * cannot do comfortably, and WASD already covers movement.
 */
export const DEFAULT_BINDINGS = {
  forward:    ['KeyW'],
  back:       ['KeyS'],
  left:       ['KeyA'],
  right:      ['KeyD'],
  sprint:     ['ShiftLeft', 'ShiftRight', 'Pad10'],
  walk:       ['AltLeft'],
  crouch:     ['ControlLeft', 'KeyC', 'Pad1'],
  prone:      ['KeyZ', 'Pad2'],
  aim:        ['Mouse2', 'KeyE', 'Pad6', 'Axis6+'],
  fire:       ['Mouse0', 'Space', 'Pad7', 'Axis7+'],
  steady:     ['ShiftLeft', 'Pad10'],
  cqc:        ['KeyF', 'Pad0'],
  cover:      ['KeyG', 'Pad3'],
  // R is reload and T is drag, not the other way round. Every shooter made in
  // the last twenty years puts reload on R, and reload is a verb a player uses
  // every fight while dragging a body is one they use a handful of times a run.
  // The acceptance probe pressed R for reload and reported the weapon broken.
  drag:       ['KeyT', 'Pad4'],
  stow:       ['KeyQ', 'Pad5'],
  swapShoulder: ['KeyV', 'Pad11'],
  reload:     ['KeyR', 'Pad8'],
  // Keyboard look, for trackpads. Held, not tapped.
  lookLeft:   ['ArrowLeft'],
  lookRight:  ['ArrowRight'],
  lookUp:     ['ArrowUp'],
  lookDown:   ['ArrowDown'],
};

/** Which pad buttons behave as analog triggers rather than switches. */
const TRIGGER_BUTTONS = new Set([6, 7]);

export class Input {
  /**
   * @param {HTMLElement} element the canvas/container that owns pointer lock
   */
  constructor(element, opts = {}) {
    this.element = element;
    this.bindings = { ...DEFAULT_BINDINGS, ...(opts.bindings ?? {}) };
    this.enabled = false;
    this.pointerLocked = false;
    this.automation = false;

    /** Look sensitivity in radians per pixel of mouse travel. */
    this.mouseSensitivity = opts.mouseSensitivity ?? 0.0022;
    /** Pad look in radians per second at full stick. */
    this.padLookRate = opts.padLookRate ?? 2.6;
    this.invertY = opts.invertY ?? false;

    this._down = new Set();     // source ids currently held
    this._prev = new Set();     // snapshot at the last update()
    /**
     * Sources that went down since the last update() — INCLUDING ones already
     * released again. Edge detection used to be purely `_down` vs `_prevSet`,
     * which silently drops any press whose whole down-up cycle fell between two
     * frames. At 50 FPS that is a 20 ms window, and a crisp tap on C or Z is
     * comfortably inside it: measured driving the real page, crouch and prone
     * never fired once because the keyup landed before the next update(). Every
     * edge-triggered verb — crouch, prone, reload, cover, CQC, swap shoulder —
     * was affected. Keydown auto-repeat is filtered upstream by `e.repeat`, so
     * latching here cannot make a held key toggle every frame.
     */
    this._taps = new Set();
    this._pendingTaps = new Set();
    this._wheel = 0;
    this._lookX = 0;
    this._lookY = 0;
    this._pad = null;
    this._padAxes = [0, 0, 0, 0];
    this._lockListeners = new Set();

    /** Move intent in camera space: x = right, y = forward, |v| <= 1. */
    this.move = { x: 0, y: 0 };
    /** Look delta accumulated for THIS frame, radians. */
    this.look = { x: 0, y: 0 };
    /** Analog magnitude of the move intent, 0..1. A keyboard reports 1. */
    this.moveMag = 0;
    /** Wheel notches since the last update, signed. */
    this.wheel = 0;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContext = (e) => e.preventDefault();
    this._onLockChange = this._onLockChange.bind(this);
    this._onBlur = () => this._down.clear();
  }

  // --- lifecycle ----------------------------------------------------------

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', this._onBlur);
    this.element.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    this.element.removeEventListener('contextmenu', this._onContext);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.releaseLock();
    this._down.clear();
    this._prev.clear();
    // A latched tap that survived a mode change would fire the frame play mode
    // is re-entered — a crouch nobody pressed.
    this._taps.clear();
    this._pendingTaps.clear();
    this.move.x = this.move.y = 0;
    this.look.x = this.look.y = 0;
    this._lookX = this._lookY = 0;
  }

  requestLock() {
    if (!this.enabled || this.pointerLocked) return;
    // Automation drives look without a lock, so do not even ask for one —
    // headless chromium answers with pointerlockerror, which main.js records
    // as a page error and fails the whole run.
    if (this.automation) return;
    // Chromium rejects a lock request that is not user-gesture driven; calling
    // it from a mousedown handler is the only reliable path. Modern Chrome
    // returns a promise for it, and an unhandled rejection is recorded by
    // main.js as a page error, which fails the whole screenshot run.
    const p = this.element.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  releaseLock() {
    if (document.pointerLockElement === this.element) document.exitPointerLock?.();
    this.pointerLocked = false;
  }

  onLockChange(fn) {
    this._lockListeners.add(fn);
    return () => this._lockListeners.delete(fn);
  }

  _onLockChange() {
    const locked = document.pointerLockElement === this.element;
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    // Losing the lock means the player hit Escape. Nothing is held any more.
    if (!locked) this._down.clear();
    for (const fn of this._lockListeners) fn(locked);
  }

  // --- rebinding ----------------------------------------------------------

  /** Replace the sources for one action. */
  rebind(action, sources) {
    this.bindings[action] = Array.isArray(sources) ? sources.slice() : [sources];
  }

  /** Add one source to an existing action without dropping the others. */
  addBinding(action, source) {
    (this.bindings[action] ??= []).push(source);
  }

  // --- listeners ----------------------------------------------------------

  _onKeyDown(e) {
    if (e.repeat) return;
    this._down.add(e.code);
    this._pendingTaps.add(e.code);
    // Arrows, space and the slash key scroll or open quick-find otherwise, and
    // a page that scrolls under a pointer-locked game is a bug the player sees
    // as the camera sticking.
    if (SWALLOW.has(e.code)) e.preventDefault();
  }

  _onKeyUp(e) {
    this._down.delete(e.code);
  }

  _onMouseDown(e) {
    this._down.add(`Mouse${e.button}`);
    this._pendingTaps.add(`Mouse${e.button}`);
    if (!this.pointerLocked) this.requestLock();
    e.preventDefault();
  }

  _onMouseUp(e) {
    this._down.delete(`Mouse${e.button}`);
  }

  /**
   * Headless chromium refuses pointer lock, and mouse look is gated on holding
   * it — so an automated run could press keys but never turn the camera. That
   * single gap is why playtest probes were launching HEADFUL browsers, which
   * steal focus and pop windows on a machine somebody is using.
   *
   * Automation mode accepts raw mousemove deltas as look input without the
   * lock. It changes nothing for a human: a real player still gets pointer lock
   * on click, and this flag is only ever set by a test harness.
   */
  setAutomation(on) {
    this.automation = !!on;
    return this.automation;
  }

  _onMouseMove(e) {
    // Automation mode accepts deltas without the lock. Headless chromium
    // refuses requestPointerLock, and gating look on it meant an automated run
    // could press keys but never turn the camera — which is the entire reason
    // playtest probes were launching headful windows over somebody's desktop.
    if (!this.pointerLocked && !this.automation) return;
    this._lookX -= e.movementX * this.mouseSensitivity;
    this._lookY -= e.movementY * this.mouseSensitivity * (this.invertY ? -1 : 1);
  }

  _onWheel(e) {
    this._wheel += Math.sign(e.deltaY);
    e.preventDefault();
  }

  // --- polling ------------------------------------------------------------

  /** Poll the pad and fold its state into the same source set as the keyboard. */
  _pollPad() {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    this._pad = pad;
    for (const id of PAD_SOURCES) this._down.delete(id);
    this._padAxes[0] = this._padAxes[1] = this._padAxes[2] = this._padAxes[3] = 0;
    if (!pad) return;

    for (let i = 0; i < pad.buttons.length && i < 18; i++) {
      const b = pad.buttons[i];
      const on = TRIGGER_BUTTONS.has(i) ? b.value > TRIGGER_ON : b.pressed;
      if (on) this._down.add(`Pad${i}`);
    }
    for (let a = 0; a < pad.axes.length && a < 8; a++) {
      const v = deadzone(pad.axes[a]);
      if (a < 4) this._padAxes[a] = v;
      if (v > AXIS_BUTTON) this._down.add(`Axis${a}+`);
      else if (v < -AXIS_BUTTON) this._down.add(`Axis${a}-`);
    }
  }

  /**
   * Advance one frame. Consumers must call `down/pressed/released` between this
   * and the next call; edges are computed here and are valid for exactly one
   * frame, which is what makes "press to toggle stance" impossible to
   * double-fire on a slow frame.
   */
  update(dt) {
    if (!this.enabled) {
      this.move.x = this.move.y = 0;
      this.look.x = this.look.y = 0;
      this.moveMag = 0;
      return;
    }
    // Pad first: its buttons live in the same source set as the keyboard, so
    // the edge snapshot has to be taken after they land or every pad press is
    // reported one frame late and every release is missed entirely.
    this._pollPad();
    // Two buffers swapped rather than a fresh Set per frame: `_prevSet` becomes
    // last frame's snapshot (what the edge tests read) and `_prev` is refilled
    // with this frame's for the next one.
    const recycled = this._prevSet ?? new Set();
    this._prevSet = this._prev;
    this._prev = recycled;
    this._prev.clear();
    for (const s of this._down) this._prev.add(s);
    // Same double-buffer trick for the tap latch: `_taps` is what pressed()
    // reads for THIS frame, `_pendingTaps` starts collecting for the next one.
    const swap = this._taps;
    this._taps = this._pendingTaps;
    this._pendingTaps = swap;
    this._pendingTaps.clear();

    // Stick beats keys when it is pushed further, so a pad plugged in mid-game
    // just works without a mode switch.
    let mx = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    let my = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0);
    let mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; mag = 1; }
    const sx = this._padAxes[0];
    const sy = -this._padAxes[1];
    const smag = Math.min(1, Math.hypot(sx, sy));
    if (smag > mag) { mx = sx; my = sy; mag = smag; }
    this.move.x = mx;
    this.move.y = my;
    this.moveMag = mag;

    this.look.x = this._lookX + this._padAxes[2] * -this.padLookRate * dt;
    this.look.y = this._lookY + this._padAxes[3] * -this.padLookRate * dt * 0.8;
    this._lookX = 0;
    this._lookY = 0;
    this.wheel = this._wheel;
    this._wheel = 0;
  }

  // --- queries ------------------------------------------------------------

  /** Held this frame. */
  down(action) {
    const srcs = this.bindings[action];
    if (!srcs) return false;
    for (const s of srcs) if (this._down.has(s)) return true;
    return false;
  }

  /** Went down between the previous update() and this one. */
  pressed(action) {
    const srcs = this.bindings[action];
    if (!srcs) return false;
    const prev = this._prevSet;
    for (const s of srcs) {
      if (this._taps.has(s)) return true;               // tap that began and ended between frames
      if (this._down.has(s) && !prev?.has(s)) return true;
    }
    return false;
  }

  /** Came up between the previous update() and this one. */
  released(action) {
    const srcs = this.bindings[action];
    if (!srcs) return false;
    const prev = this._prevSet;
    for (const s of srcs) if (!this._down.has(s) && prev?.has(s)) return true;
    return false;
  }

  get hasPad() {
    return !!this._pad;
  }
}

const SWALLOW = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash',
]);

const PAD_SOURCES = [];
for (let i = 0; i < 18; i++) PAD_SOURCES.push(`Pad${i}`);
for (let a = 0; a < 8; a++) PAD_SOURCES.push(`Axis${a}+`, `Axis${a}-`);

function deadzone(v) {
  const a = Math.abs(v);
  if (a < AXIS_DEAD) return 0;
  return Math.sign(v) * ((a - AXIS_DEAD) / (1 - AXIS_DEAD));
}
