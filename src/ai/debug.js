import * as THREE from 'three';
import { AWARE, SIGHT, eyeOf } from './perception.js';

/**
 * Debug visualisation: vision cones, awareness meters, current path, and the
 * baked navigation grid. Off by default and it allocates nothing per frame —
 * one LineSegments with a fixed-size buffer whose draw range is set to however
 * much was written this frame, so toggling it never touches the GPU allocator.
 *
 * This exists because a stealth AI is invisible by construction. Every number
 * that matters — where a guard is actually looking, how full his meter is, what
 * the pathfinder thinks is a wall — has no on-screen consequence until the
 * moment it is too late to see what happened.
 *
 * Key `G` cycles: off -> cones+meters -> ... + nav grid -> off.
 */

const MAX_VERTS = 24000;
const ARC = 14;

const COLOUR = {
  CALM: [0.15, 1.6, 0.5],
  CAUTION: [2.2, 1.7, 0.15],
  ALERT: [2.6, 0.25, 0.15],
  EVASION: [2.4, 0.9, 0.1],
  down: [0.35, 0.35, 0.45],
  path: [0.2, 1.1, 2.4],
  meterBg: [0.25, 0.25, 0.3],
};

const _eye = new THREE.Vector3();

export class AIDebug {
  constructor(scene) {
    this.scene = scene;
    this.level = 0;
    this.pos = new Float32Array(MAX_VERTS * 3);
    this.col = new Float32Array(MAX_VERTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setDrawRange(0, 0);
    // frustumCulled off: the bounding sphere is never recomputed, and a stale
    // one makes the whole overlay vanish the moment a guard walks out of it.
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, fog: false, depthWrite: false }),
    );
    this.lines.name = 'ai-debug';
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.renderOrder = 9000;
    scene.add(this.lines);
    this.n = 0;
    this.gridPoints = null;
  }

  set(level) {
    this.level = level | 0;
    this.lines.visible = this.level > 0;
    if (this.gridPoints) this.gridPoints.visible = this.level >= 2;
  }

  toggle() { this.set((this.level + 1) % 3); }

  dispose() {
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    if (this.gridPoints) {
      this.scene.remove(this.gridPoints);
      this.gridPoints.geometry.dispose();
      this.gridPoints.material.dispose();
    }
  }

  _seg(ax, ay, az, bx, by, bz, c) {
    if (this.n + 2 > MAX_VERTS) return;
    const p = this.pos;
    const q = this.col;
    let i = this.n * 3;
    p[i] = ax; p[i + 1] = ay; p[i + 2] = az;
    q[i] = c[0]; q[i + 1] = c[1]; q[i + 2] = c[2];
    i += 3;
    p[i] = bx; p[i + 1] = by; p[i + 2] = bz;
    q[i] = c[0]; q[i + 1] = c[1]; q[i + 2] = c[2];
    this.n += 2;
  }

  update(guards, squad, camera, grid) {
    if (this.level <= 0) return;
    this.n = 0;
    const base = COLOUR[squad.level] ?? COLOUR.CALM;
    for (const g of guards) {
      const c = g.down ? COLOUR.down : (g.vis.visible ? COLOUR.ALERT : base);
      eyeOf(g.ch, _eye);
      const ey = _eye.y;

      if (!g.down) {
        // Vision cone, drawn on the deck so it reads against the terrain, with
        // the range it ACTUALLY has right now (alert guards see further).
        const r = Math.min(48, SIGHT.range * (g.alerted ? SIGHT.alertRange : 1));
        const half = THREE.MathUtils.degToRad(SIGHT.fovDeg) * 0.5;
        const gy = (g.ch.groundY ?? g.ch.position.y) + 0.06;
        let px = null;
        let pz = null;
        for (let i = 0; i <= ARC; i++) {
          const a = g.lookYaw - half + (2 * half * i) / ARC;
          const x = g.ch.position.x - Math.sin(a) * r;
          const z = g.ch.position.z - Math.cos(a) * r;
          if (px !== null) this._seg(px, gy, pz, x, gy, z, c);
          if (i === 0 || i === ARC) this._seg(g.ch.position.x, gy, g.ch.position.z, x, gy, z, c);
          px = x; pz = z;
        }
        // The eyeline itself: the single most useful line in the overlay.
        this._seg(_eye.x, ey, _eye.z,
          _eye.x - Math.sin(g.lookYaw) * 4, ey, _eye.z - Math.cos(g.lookYaw) * 4, c);
      }

      // Awareness meter: a 0.8 m bar above the head, camera-facing.
      const top = (g.ch.groundY ?? g.ch.position.y) + 2.35;
      const rx = camera ? camera.matrixWorld.elements[0] : 1;
      const rz = camera ? camera.matrixWorld.elements[2] : 0;
      const w = 0.8;
      const x0 = g.ch.position.x - rx * w * 0.5;
      const z0 = g.ch.position.z - rz * w * 0.5;
      this._seg(x0, top, z0, x0 + rx * w, top, z0 + rz * w, COLOUR.meterBg);
      const a = THREE.MathUtils.clamp(g.awareness, 0, 1);
      if (a > 0.001) {
        const mc = a >= AWARE.DETECT ? COLOUR.ALERT : a >= AWARE.SUSPECT ? COLOUR.EVASION : COLOUR.CAUTION;
        this._seg(x0, top + 0.02, z0, x0 + rx * w * a, top + 0.02, z0 + rz * w * a, mc);
        this._seg(x0, top + 0.04, z0, x0 + rx * w * a, top + 0.04, z0 + rz * w * a, mc);
      }

      // The path he is actually walking, corner to corner.
      if (g.path && g.path.length) {
        let ax = g.ch.position.x;
        let ay = (g.ch.groundY ?? 0) + 0.15;
        let az = g.ch.position.z;
        for (let i = g.pathI; i < g.path.length; i++) {
          const p = g.path[i];
          this._seg(ax, ay, az, p.x, p.y + 0.15, p.z, COLOUR.path);
          ax = p.x; ay = p.y + 0.15; az = p.z;
        }
      }
    }

    // The squad blackboard: where they think you are.
    if (squad.hasLastKnown) {
      const k = squad.lastKnown;
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2;
        const a1 = ((i + 1) / 8) * Math.PI * 2;
        this._seg(
          k.x + Math.cos(a0) * 1.2, k.y + 0.1, k.z + Math.sin(a0) * 1.2,
          k.x + Math.cos(a1) * 1.2, k.y + 0.1, k.z + Math.sin(a1) * 1.2,
          COLOUR.ALERT,
        );
      }
      this._seg(k.x, k.y, k.z, k.x, k.y + 2.2, k.z, COLOUR.ALERT);
    }

    const geo = this.lines.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, this.n);

    if (this.level >= 2 && !this.gridPoints && grid) this._buildGrid(grid);
  }

  /** One point per blocked cell. Built lazily; it is a lot of vertices. */
  _buildGrid(grid) {
    const pts = [];
    for (let iz = 0; iz < grid.nz; iz++) {
      for (let ix = 0; ix < grid.nx; ix++) {
        const i = iz * grid.nx + ix;
        if (!grid.blocked[i]) continue;
        pts.push(grid.cx(ix), grid.ground[i] + 0.1, grid.cz(iz));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gridPoints = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.35, color: new THREE.Color(1.4, 0.4, 1.6), fog: false }),
    );
    this.gridPoints.name = 'ai-navgrid';
    this.gridPoints.frustumCulled = false;
    this.scene.add(this.gridPoints);
  }
}
