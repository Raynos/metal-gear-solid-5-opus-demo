/**
 * Settings.js — the settings model, its side effects, and its panel.
 *
 * Controls are hairline segmented cells and a 1px slider, never a rounded
 * button: this is a technical readout that happens to be adjustable.
 *
 * ONE IMPORTANT SUBTLETY. Persisted settings are NOT applied at boot. They are
 * armed by the first real user input on the page. The screenshot daemon runs a
 * long-lived chromium and never touches the UI, so without this latch a stale
 * `renderScale: 0.5` in localStorage would silently halve the resolution of
 * every canonical shot in the repo and nothing would say so. Defaults are
 * whatever `Engine`/`RenderPipeline` already chose, which is what the perf probe
 * and the visual critics must keep measuring.
 */

import { el, attr, css, write } from './dom.js';

const KEY = 'tpp.ui.settings';

export const DEFAULTS = {
  renderScale: 1.0,
  shadowQuality: 2048,
  ssao: true,
  bloom: true,
  dof: true,
  motionBlur: true,
  taa: true,
  sensitivity: 1.0,
  invertY: false,
};

const SCALES = [
  [0.5, '50'],
  [0.75, '75'],
  [1.0, '100'],
  [1.25, '125'],
];
const SHADOWS = [
  [512, 'LOW'],
  [1024, 'MED'],
  [2048, 'HIGH'],
];
const BOOL = [
  [false, 'OFF'],
  [true, 'ON'],
];

export class Settings {
  constructor(world) {
    this.world = world;
    this.values = { ...DEFAULTS, ...load() };
    this.armed = false;
    this._subs = new Set();
    this._rows = [];
    this.el = null;
    this.sel = 0;
  }

  /** Apply everything once the player has proved they are a player. */
  arm() {
    if (this.armed) return;
    this.armed = true;
    for (const k in this.values) this._effect(k);
  }

  onChange(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    save(this.values);
    if (this.armed) this._effect(key);
    for (const fn of this._subs) fn(key, value, this.values);
    this._sync();
  }

  // --- side effects -------------------------------------------------------

  _effect(key) {
    const { engine } = this.world;
    const pipe = engine.pipeline;
    const v = this.values[key];
    switch (key) {
      case 'renderScale': {
        // Engine._onResize reads renderer.getPixelRatio(), so setting the ratio
        // and firing a resize is the whole implementation — and it goes through
        // the public path rather than reaching into another author's method.
        const base = Math.min(window.devicePixelRatio || 1, 2);
        engine.renderer.setPixelRatio(base * v);
        window.dispatchEvent(new Event('resize'));
        break;
      }
      case 'shadowQuality': {
        for (const light of this.world.lighting?.cascades ?? []) {
          if (light.shadow.mapSize.x === v) continue;
          light.shadow.mapSize.set(v, v);
          // three only allocates the depth target once; drop it and the next
          // shadow pass rebuilds at the new size. No shader recompile.
          light.shadow.map?.dispose();
          light.shadow.map = null;
          light.shadow.needsUpdate = true;
        }
        break;
      }
      case 'ssao':
      case 'bloom':
      case 'dof':
      case 'motionBlur':
      case 'taa':
        if (pipe?.enabled) pipe.enabled[key] = v;
        break;
      default:
        // sensitivity / invertY are read by whoever owns a camera; publishing
        // them on the registry is the whole contract.
        break;
    }
  }

  // --- panel --------------------------------------------------------------

  build() {
    const rows = [];

    const seg = (key, options) => {
      const cells = options.map(([value, label]) => el('u', { text: label, 'data-v': this.values[key] === value ? '1' : '0' }));
      const node = el('button.opt', { type: 'button', 'data-on': '0' }, [
        el('span.ol', { text: labelFor(key) }),
        el('span.seg', null, cells),
      ]);
      const idx = () => options.findIndex(([v]) => v === this.values[key]);
      const row = {
        node,
        sync: () => cells.forEach((c, i) => attr(c, 'data-v', options[i][0] === this.values[key] ? '1' : '0')),
        adjust: (dir) => {
          const n = options.length;
          this.set(key, options[(idx() + dir + n) % n][0]);
        },
        activate: () => row.adjust(1),
      };
      cells.forEach((c, i) => {
        c.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.set(key, options[i][0]);
        });
        // The row's own click handler advances the segment. Without this, a
        // click on a cell would set that cell's value and then step past it.
        c.addEventListener('click', (e) => e.stopPropagation());
      });
      rows.push(row);
      return node;
    };

    const slider = (key, min, max, step, fmt) => {
      const fil = el('span.fil');
      const hnd = el('span.hnd');
      const val = el('span.val');
      const trk = el('span.trk', null, [fil, hnd]);
      const node = el('button.opt', { type: 'button', 'data-on': '0' }, [
        el('span.ol', { text: labelFor(key) }),
        el('span.sld', null, [trk, val]),
      ]);
      const row = {
        node,
        sync: () => {
          const t = (this.values[key] - min) / (max - min);
          css(fil, 'width', `${(t * 100).toFixed(1)}%`);
          css(hnd, 'transform', `translateX(${(t * 100).toFixed(1)}%)`);
          write(val, fmt(this.values[key]));
        },
        adjust: (dir) => {
          const next = Math.round((this.values[key] + dir * step) / step) * step;
          this.set(key, Math.max(min, Math.min(max, +next.toFixed(4))));
        },
        activate: () => {},
      };
      const fromEvent = (e) => {
        const r = trk.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        this.set(key, +(min + t * (max - min)).toFixed(4));
      };
      trk.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        trk.setPointerCapture(e.pointerId);
        fromEvent(e);
        const move = (ev) => fromEvent(ev);
        const up = () => {
          trk.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        trk.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      rows.push(row);
      return node;
    };

    const body = el('div', null, [
      el('h2', { text: 'Settings' }),
      el('div.grp', { text: 'DISPLAY' }),
      seg('renderScale', SCALES),
      seg('shadowQuality', SHADOWS),
      el('div.grp', { text: 'IMAGE' }),
      seg('ssao', BOOL),
      seg('bloom', BOOL),
      seg('dof', BOOL),
      seg('motionBlur', BOOL),
      seg('taa', BOOL),
      el('div.grp', { text: 'INPUT' }),
      slider('sensitivity', 0.2, 3.0, 0.05, (v) => `${v.toFixed(2)}x`),
      seg('invertY', BOOL),
      el('div.hint', null, [
        el('span', { text: 'ARROWS ADJUST · ' }),
        el('b', { text: 'ESC' }),
        el('span', { text: ' BACK' }),
      ]),
    ]);

    this.el = el('section.set', null, [body]);
    this._rows = rows;
    rows.forEach((r, i) => {
      r.node.addEventListener('pointerenter', () => this.focus(i));
      r.node.addEventListener('click', () => {
        this.focus(i);
        r.activate();
      });
    });
    this._sync();
    return this.el;
  }

  get count() {
    return this._rows.length;
  }

  focus(i) {
    this.sel = Math.max(0, Math.min(this._rows.length - 1, i));
    this._rows.forEach((r, n) => attr(r.node, 'data-on', n === this.sel ? '1' : '0'));
  }

  adjust(dir) {
    this._rows[this.sel]?.adjust(dir);
  }

  activate() {
    this._rows[this.sel]?.activate();
  }

  _sync() {
    for (const r of this._rows) r.sync();
  }
}

function labelFor(key) {
  return (
    {
      renderScale: 'Render scale',
      shadowQuality: 'Shadow quality',
      ssao: 'Ambient occlusion',
      bloom: 'Bloom',
      dof: 'Depth of field',
      motionBlur: 'Motion blur',
      taa: 'Temporal AA',
      sensitivity: 'Mouse sensitivity',
      invertY: 'Invert look',
    }[key] ?? key
  );
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

function save(values) {
  try {
    localStorage.setItem(KEY, JSON.stringify(values));
  } catch {
    /* private browsing; settings are session-only, which is fine */
  }
}
