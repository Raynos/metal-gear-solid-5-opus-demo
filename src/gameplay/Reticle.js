import * as THREE from 'three';

/**
 * The aiming reticle.
 *
 * Taken off the reference frame rather than invented: in MGSV the reticle is a
 * small hollow SQUARE — not a cross, not a dot — with the range to whatever is
 * under it set in small type above, and it is only on screen while the weapon
 * is up. (mgi-5: a 16 px box at frame centre reading "78m", with the hostile
 * marker as a separate red chevron somewhere else entirely.)
 *
 * It is drawn in the DOM for the same reason the HUD is: it costs no GPU frame
 * time at all, and the only per-frame writes are `transform` and two custom
 * properties, which the compositor takes without a layout pass.
 *
 * WHERE IT GOES is the whole point of drawing one. The shot leaves the camera's
 * optical axis with the sway added (see Stealth.aimRay), so a reticle nailed to
 * the centre of the screen would be a lie in exactly the moments that matter —
 * the sway is the aiming, and a sight that does not move with it is decoration.
 * This projects the point the dart would actually reach.
 *
 * It is suppressed outside play mode, and again whenever the screenshot harness
 * is driving: `tools/render.mjs` takes a full-page capture, so a stray overlay
 * would land in every canonical frame in the repo.
 */

const CSS = `
/*
 * IT HAS TO READ ON SAND, and until round 12 it did not.
 *
 * A near-white 1 px stroke at 0.86 alpha, over a 1 px dark ring at 0.55, is a
 * sight designed against a dark background. This game is set on a high-key
 * desert floor whose display luminance is calibrated to land near 0.5 — the
 * same value as the stroke — and the round-12 ADS frame shows the result: the
 * reticle is at the point the probe says it is, at opacity 0.94, and you cannot
 * find it in the image. It was reported to me as "there is no reticle in the
 * frame at all". There is; it is camouflaged.
 *
 * Fixed by contrast rather than by size: the stroke goes opaque, the dark ring
 * goes to 0.85 and is doubled to a 2 px halo, and the range text gets the same
 * halo instead of a soft drop shadow. A 16 px box is the reference frame's own
 * size and enlarging it would have traded away the thing it is measuring.
 */
.gp-ret {
  position: absolute; left: 0; top: 0; width: 0; height: 0;
  z-index: 1; pointer-events: none; opacity: 0;
  --col: rgba(246, 249, 243, 1);
  --shd: rgba(3, 5, 7, 0.85);
  transition: opacity 90ms linear;
  font: 400 11px/1 "Helvetica Neue", "Inter", system-ui, sans-serif;
  letter-spacing: 0.09em;
  color: var(--col);
  text-shadow: 0 0 3px var(--shd), 0 1px 1px var(--shd), 0 -1px 1px var(--shd),
               1px 0 1px var(--shd), -1px 0 1px var(--shd);
  will-change: transform;
}
.gp-ret b {
  position: absolute; display: block;
  width: var(--sz); height: var(--sz);
  left: calc(var(--sz) / -2); top: calc(var(--sz) / -2);
  border: 1px solid var(--col);
  box-shadow: 0 0 0 1px var(--shd), 0 0 0 2px rgba(3, 5, 7, 0.45),
              inset 0 0 0 1px var(--shd);
  transition: width 70ms ease-out, height 70ms ease-out, left 70ms ease-out, top 70ms ease-out, border-color 120ms linear;
}
/* Centre pip: only when the trace is on a body, so it reads as confirmation. */
.gp-ret i {
  position: absolute; left: -1.5px; top: -1.5px; width: 3px; height: 3px;
  background: var(--col); opacity: 0;
  box-shadow: 0 0 0 1px var(--shd), 0 0 3px var(--shd);
  transition: opacity 90ms linear;
}
.gp-ret u {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(var(--sz) / 2 + 7px);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
.gp-ret[data-on="1"] i { opacity: 1; }
.gp-ret[data-on="1"] { --col: rgba(217, 164, 65, 0.95); }
/* The hit tick: a ring that expands once and is gone. */
.gp-ret s {
  position: absolute; left: -9px; top: -9px; width: 18px; height: 18px;
  border: 1px solid rgba(233, 237, 230, 0.9); opacity: 0;
}
.gp-ret[data-hit="1"] s { animation: gp-ret-hit 320ms ease-out 1; }
/* A headshot: wider, brighter, held a beat longer. */
.gp-ret[data-hit="2"] s {
  animation: gp-ret-head 420ms ease-out 1;
  border-color: rgba(255, 244, 226, 1);
  border-width: 2px;
}
@keyframes gp-ret-hit {
  from { opacity: 0.95; transform: scale(0.45) rotate(0deg); }
  to   { opacity: 0; transform: scale(1.9) rotate(45deg); }
}
@keyframes gp-ret-head {
  from { opacity: 1; transform: scale(0.35) rotate(0deg); }
  to   { opacity: 0; transform: scale(2.8) rotate(90deg); }
}
`;

export class Reticle {
  /**
   * @param {HTMLElement} parent the element the canvas lives in
   * @param {object} deps { camera, stealth, controller }
   */
  constructor(parent, { camera, stealth }) {
    this.cam = camera;
    this.stealth = stealth;
    this._v = new THREE.Vector3();
    this._range = -1;
    this._on = false;
    this._hitT = 0;

    if (!document.getElementById('gp-ret-css')) {
      const s = document.createElement('style');
      s.id = 'gp-ret-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const el = document.createElement('div');
    el.className = 'gp-ret';
    el.innerHTML = '<b></b><i></i><s></s><u></u>';
    el.style.setProperty('--sz', '16px');
    this.el = el;
    this.range = el.querySelector('u');
    (parent ?? document.body).appendChild(el);
  }

  /**
   * Flash the hit tick. Wired to the stealth module's `tranq` event.
   *
   * `strong` is a headshot. The trace has computed that flag since the weapon
   * was written and nothing read it, so the one thing the simulation knew about
   * the quality of the shot never reached the person who took it.
   */
  confirm(strong = false) {
    this._hitT = strong ? 0.44 : 0.34;
    this.el.setAttribute('data-hit', strong ? '2' : '1');
  }

  hide() {
    this.el.style.opacity = '0';
  }

  dispose() {
    this.el.remove();
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera3d
   * @param {boolean} visible false in every mode but play, and under the harness
   */
  update(dt, camera3d, visible) {
    if (this._hitT > 0) {
      this._hitT -= dt;
      if (this._hitT <= 0) this.el.removeAttribute('data-hit');
    }
    const a = this.stealth.aimAmount;
    if (!visible || a < 0.04) {
      if (this.el.style.opacity !== '0') this.el.style.opacity = '0';
      return;
    }

    const hit = this.stealth.aimHit;
    // `sightPoint` is the round's position at the range the sight is convergent
    // on — see Stealth._predict for why this is not `hit.point`. The fallbacks
    // are for a build or a frame where the stealth module has not solved one.
    const p = this._v.copy(this.stealth.sightPoint ?? hit?.point ?? this.stealth.aimPoint).project(camera3d);
    // Behind the camera means the aim point is degenerate; drop the reticle
    // rather than mirroring it to the wrong side of the frame.
    if (p.z > 1) { this.el.style.opacity = '0'; return; }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = (p.x * 0.5 + 0.5) * w;
    const y = (-p.y * 0.5 + 0.5) * h;
    this.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    this.el.style.opacity = (a * 0.94).toFixed(2);

    // THE BOX IS THE CONE. It used to have two sizes — 16 px, or 12 px while
    // the breath was held — which is a light on a dashboard, not a sight.
    // Everything that makes the weapon less precise now opens it: the stance,
    // the breath, how fast the player is moving, and how many rounds have just
    // left the barrel. `swayScale` is 1.0 for a standing, rested, motionless
    // shooter, so 16 px still means exactly what it used to mean.
    //
    // Quantised to 2 px because this is a CSS custom property write on a
    // transitioning element, and a fresh value every frame both costs a style
    // recalc and fights the 70 ms transition that makes the open/close read.
    const sz = Math.max(9, Math.min(64, Math.round(16 * this.stealth.swayScale / 2) * 2));
    if (sz !== this._sz) { this._sz = sz; this.el.style.setProperty('--sz', `${sz}px`); }

    const on = !!hit?.character && !hit.character.downed;
    if (on !== this._on) {
      this._on = on;
      this.el.setAttribute('data-on', on ? '1' : '0');
    }

    // Range in whole metres, and only when there is something to range to —
    // "0m" over open sky is noise.
    const d = hit ? Math.round(hit.dist) : -1;
    if (d !== this._range) {
      this._range = d;
      this.range.textContent = d >= 0 ? `${d}m` : '';
    }
  }
}
