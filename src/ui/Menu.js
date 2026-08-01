/**
 * Menu.js — the front end, plus the slow orbit that turns the live world into
 * its backdrop.
 *
 * The layout is a single left column of hairline-ruled rows against a mostly
 * uncovered world: the scrim only darkens the left third, because the backdrop
 * is the product, not wallpaper. Descriptors under each option are monospace
 * and rise to full opacity only for the selected row — the same
 * fades-out-when-irrelevant rule the HUD follows, applied to the menu.
 *
 * The signature detail is the telemetry rail along the bottom: real azimuth,
 * altitude, sun elevation and frame rate, read from the engine that is drawing
 * the picture behind it, at 4 Hz. It costs nothing and it makes the menu an
 * instrument reading the world rather than a layer floating over it.
 *
 * THE BACKDROP CAMERA NEVER FIGHTS THE HARNESS. It writes `engine.camera` only
 * while the mode is 'menu', the engine is not deterministic, and the harness has
 * never taken the wheel (`isHarnessDriving()`). All three must hold.
 */

import * as THREE from 'three';
import { el, attr, write } from './dom.js';

const R = 92; // orbit radius over the outpost, metres
const H = 24; // orbit altitude
const RATE = 0.011; // rad/s — about 0.63 deg/s; a slow drift, not a carousel
const PARK_AFTER = 20; // seconds of no input at all before the orbit stops

export class Menu {
  /**
   * @param {object} world
   * @param {import('./Settings.js').Settings} settings
   * @param {{ setMode(m:string):void }} gameState
   * @param {() => boolean} isHarnessDriving
   */
  constructor(world, settings, gameState, isHarnessDriving) {
    this.world = world;
    this.settings = settings;
    this.gameState = gameState;
    this.isHarnessDriving = isHarnessDriving;

    this.panel = 'menu';
    this.sel = 0;
    // Chosen to match the known-good `outpost` framing: the compound's lit west
    // flank with the ridge behind it.
    this.theta = Math.atan2(58, 72);
    this._fps = 60;
    this._telAcc = 0;
    this._target = new THREE.Vector3(0, 3, 0);

    /**
     * Set by index.js on the first real user input. Until then the orbit parks
     * itself after PARK_AFTER seconds: an unattended page — which is exactly
     * what the shared render daemon keeps resident for every working tree — must
     * not sit there moving a camera, because a moving camera invalidates TAA
     * history and re-renders shadow cascades every single frame. A human moves
     * the mouse in the first few seconds and never sees the park.
     */
    this.interacted = false;
    this._idle = 0;

    this.actions = [
      { key: 'play', label: 'New game', desc: 'INFILTRATE THE OUTPOST', run: () => gameState.setMode('play') },
      { key: 'god', label: 'God mode', desc: 'FREE CAMERA · WASD + DRAG', run: () => gameState.setMode('godmode') },
      { key: 'set', label: 'Settings', desc: 'DISPLAY · IMAGE · INPUT', run: () => this.openSettings() },
    ];

    this.el = this._build();
  }

  _build() {
    this.caret = el('div.caret');
    this.rows = this.actions.map((a, i) => {
      const node = el('button.row', { type: 'button', 'data-on': i === 0 ? '1' : '0' }, [
        el('span.rl', { text: a.label }),
        el('span.rd', { text: a.desc }),
      ]);
      node.addEventListener('pointerenter', () => this.focus(i));
      node.addEventListener('click', () => {
        this.focus(i);
        a.run();
      });
      return node;
    });

    this.stack = el('nav.stack', { role: 'menu' }, [this.caret, ...this.rows]);

    this.tel = {
      az: el('b'),
      alt: el('b'),
      sun: el('b'),
      tod: el('b'),
      fps: el('b'),
    };
    const field = (k, node) => el('span', null, [el('i', { text: k }), node]);

    return el('section.menu', null, [
      el('header', null, [
        el('div.eyebrow', null, [el('s'), el('span', { text: 'Operation' }), el('em', { text: '51-J' }), el('span', { text: '— Afghanistan · 1984' })]),
        el('h1.wordmark', null, [el('u', { text: 'The' }), el('u', { text: 'Phantom' }), el('u', { text: 'Pain' })]),
        el('div.sub', { text: 'A PROCEDURAL FIELD EXERCISE · THREE.JS' }),
      ]),
      this.stack,
      el('div.tel', null, [
        field('AZ', this.tel.az),
        field('ALT', this.tel.alt),
        field('SUN', this.tel.sun),
        field('TOD', this.tel.tod),
        field('FPS', this.tel.fps),
      ]),
    ]);
  }

  // --- selection ----------------------------------------------------------

  focus(i) {
    const n = this.rows.length;
    this.sel = ((i % n) + n) % n;
    this.rows.forEach((r, k) => attr(r, 'data-on', k === this.sel ? '1' : '0'));
    const row = this.rows[this.sel];
    this.caret.style.transform = `translateY(${row.offsetTop + row.offsetHeight / 2}px)`;
  }

  /** Re-measure the caret after the panel becomes visible (offsetTop is 0 while hidden). */
  refresh() {
    this.panel = 'menu';
    this.focus(this.sel);
  }

  openSettings() {
    this.panel = 'settings';
    this.settings.focus(0);
  }

  closeSettings() {
    this.refresh();
  }

  activate() {
    this.actions[this.sel]?.run();
  }

  // --- backdrop orbit -----------------------------------------------------

  update(dt, engine, mode) {
    if (mode !== 'menu') return;
    if (engine.deterministic || this.isHarnessDriving()) return;
    if (!this.interacted) {
      this._idle += dt;
      if (this._idle > PARK_AFTER) return;
    }

    this.theta += RATE * dt;
    const cam = engine.camera;
    // A shallow vertical breathe on top of the orbit: enough that the frame is
    // never quite static, small enough that it never reads as a camera move.
    const y = H + Math.sin(this.theta * 1.7) * 1.6;
    cam.position.set(Math.sin(this.theta) * R, y, Math.cos(this.theta) * R);
    cam.lookAt(this._target);
    if (cam.fov !== 42) {
      cam.fov = 42;
      cam.updateProjectionMatrix();
    }

    if (dt > 0) this._fps += (1 / dt - this._fps) * Math.min(1, dt * 3);

    this._telAcc += dt;
    if (this._telAcc < 0.25) return;
    this._telAcc = 0;
    const az = ((THREE.MathUtils.radToDeg(Math.atan2(-cam.position.x, -cam.position.z)) % 360) + 360) % 360;
    write(this.tel.az, `${az.toFixed(1)}°`);
    write(this.tel.alt, `${cam.position.y.toFixed(0)}M`);
    const sun = this.world.lighting?.sunDirection;
    write(this.tel.sun, sun ? `${THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1))).toFixed(1)}°` : '—');
    write(this.tel.tod, (this.world.lighting?.todName ?? '—').toUpperCase());
    write(this.tel.fps, String(Math.round(this._fps)).padStart(2, '0'));
  }
}
