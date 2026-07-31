import * as THREE from 'three';
import { mulberry32 } from './VegField.js';

/**
 * Branching — a recursive skeletal-plant generator.
 *
 * One generator drives both the thorny scrub and the dead trees; they differ
 * only in parameters. Every branch is a tapered prism whose side count falls with
 * depth, which is where nearly all the triangle savings come from: a twig is
 * three-sided and nobody can tell.
 *
 * Each vertex carries aVeg = (flex, phase, 0). `flex` is the normalised distance
 * travelled from the root along the branch path, so the wind shader can pin the
 * trunk and let the twig-ends whip.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3();

function ringBasis(dir, outU, outV) {
  const up = Math.abs(dir.y) > 0.94 ? _up.set(1, 0, 0) : _up.set(0, 1, 0);
  outU.crossVectors(dir, up).normalize();
  outV.crossVectors(dir, outU).normalize();
}

/** Side count by thickness, not by depth — a 6-gon twig is wasted budget. */
function sidesFor(radius) {
  return radius > 0.075 ? 6 : radius > 0.028 ? 4 : 3;
}

class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.veg = [];
    this.idx = [];
  }

  /** Tapered prism along a poly-line, welded ring to ring. */
  strand(points, radii, flexes, sides, phase) {
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const start = this.pos.length / 3;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i < points.length - 1) dir.subVectors(points[i + 1], p).normalize();
      else dir.subVectors(p, points[i - 1]).normalize();
      ringBasis(dir, u, v);
      const r = radii[i];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const nx = u.x * Math.cos(a) + v.x * Math.sin(a);
        const ny = u.y * Math.cos(a) + v.y * Math.sin(a);
        const nz = u.z * Math.cos(a) + v.z * Math.sin(a);
        this.pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r);
        this.nrm.push(nx, ny, nz);
        this.veg.push(flexes[i], phase, 0);
      }
    }
    for (let i = 0; i < points.length - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        const a = start + i * sides + k;
        const b = start + i * sides + k2;
        const c = start + (i + 1) * sides + k2;
        const d = start + (i + 1) * sides + k;
        this.idx.push(a, b, c, a, c, d);
      }
    }
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('aVeg', new THREE.Float32BufferAttribute(this.veg, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * @param {object} p  growth parameters
 * @returns {THREE.BufferGeometry} with position/normal/aVeg
 */
export function growPlant(p) {
  const rng = mulberry32(p.seed);
  const B = new Builder();
  const totalReach = p.length * 2.2;

  function grow(origin, dir, length, radius, depth, pathLen) {
    const segs = depth === 0 ? p.trunkSegments : depth === 1 ? 2 : 1;
    const sides = sidesFor(radius);
    const pts = [origin.clone()];
    const radii = [radius];
    const flexes = [Math.min(1, pathLen / totalReach)];

    const d = dir.clone().normalize();
    let cur = origin.clone();
    let len = 0;
    for (let s = 1; s <= segs; s++) {
      // Gnarl: each segment veers, and gravity/light pull it back toward vertical.
      const wobble = p.gnarl * (depth === 0 ? 1.0 : 0.7);
      d.x += (rng() - 0.5) * wobble;
      d.y += (rng() - 0.5) * wobble + p.upright * (depth === 0 ? 0.14 : 0.05);
      d.z += (rng() - 0.5) * wobble;
      d.normalize();
      const sl = length / segs;
      cur = cur.clone().addScaledVector(d, sl);
      len += sl;
      pts.push(cur);
      radii.push(radius * (1 - (s / segs) * p.taper));
      flexes.push(Math.min(1, (pathLen + len) / totalReach));
    }
    B.strand(pts, radii, flexes, sides, rng());

    if (depth >= p.maxDepth || radius * (1 - p.taper) < p.minRadius) return;

    const tip = pts[pts.length - 1];
    const childCount = depth === 0 ? p.trunkChildren : rng() < p.branchProb ? 2 : 1;
    for (let c = 0; c < childCount; c++) {
      const spread = p.spread * (0.55 + rng() * 0.9);
      const az = (c / childCount) * Math.PI * 2 + rng() * 1.4 + depth * 2.1;
      // Rotate the parent direction away from itself by `spread` about a random azimuth.
      ringBasis(d, _a, _b);
      const off = _a
        .clone()
        .multiplyScalar(Math.cos(az))
        .addScaledVector(_b, Math.sin(az))
        .multiplyScalar(Math.tan(spread));
      const nd = d.clone().add(off).normalize();
      grow(tip, nd, length * (p.lengthFalloff * (0.75 + rng() * 0.5)), radius * (1 - p.taper) * p.radiusFalloff, depth + 1, pathLen + len);
    }
  }

  const root = new THREE.Vector3(0, 0, 0);
  for (let s = 0; s < p.stems; s++) {
    const az = (s / p.stems) * Math.PI * 2 + rng() * 0.9;
    const lean = p.stemLean * (0.4 + rng());
    const dir = new THREE.Vector3(Math.cos(az) * Math.sin(lean), Math.cos(lean), Math.sin(az) * Math.sin(lean));
    const r = p.stems > 1 ? p.baseSpread * Math.sqrt(rng()) : 0;
    root.set(Math.cos(az) * r, -0.04, Math.sin(az) * r);
    grow(root, dir, p.length * (0.75 + rng() * 0.5), p.radius * (0.8 + rng() * 0.4), 0, 0);
  }

  return B.toGeometry();
}

/** Thorny low scrub: many stems from a common crown, wide angles, no leader. */
export function scrubParams(seed) {
  return {
    seed,
    stems: 5,
    stemLean: 0.66,
    baseSpread: 0.19,
    length: 0.58,
    radius: 0.032,
    taper: 0.40,
    minRadius: 0.0060,
    maxDepth: 3,
    trunkSegments: 2,
    trunkChildren: 3,
    branchProb: 0.80,
    lengthFalloff: 0.70,
    radiusFalloff: 0.64,
    spread: 0.78,
    gnarl: 0.42,
    upright: 0.05,
  };
}

/** Dead tree: a single gnarled leader that forks hard — pure silhouette. */
export function deadTreeParams(seed) {
  return {
    seed,
    stems: 1,
    stemLean: 0.10,
    baseSpread: 0,
    length: 2.5,
    radius: 0.20,
    taper: 0.34,
    minRadius: 0.016,
    maxDepth: 4,
    trunkSegments: 4,
    trunkChildren: 3,
    branchProb: 0.85,
    lengthFalloff: 0.72,
    radiusFalloff: 0.72,
    spread: 0.62,
    gnarl: 0.30,
    upright: 0.10,
  };
}

/** Tumbleweed / dry brush ball: stems radiating from a centre, tangled. */
export function brushParams(seed) {
  return {
    seed,
    stems: 6,
    stemLean: 1.15,
    baseSpread: 0.05,
    length: 0.27,
    radius: 0.011,
    taper: 0.40,
    minRadius: 0.0070,
    maxDepth: 2,
    trunkSegments: 1,
    trunkChildren: 2,
    branchProb: 0.85,
    lengthFalloff: 0.80,
    radiusFalloff: 0.70,
    spread: 0.95,
    gnarl: 0.55,
    upright: -0.06,
  };
}
