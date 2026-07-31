import * as THREE from 'three';
import { makeRng } from './rng.js';
import { MODE, createSurface } from './mat.js';
import { merge, instanced, makeVars, xform, bakeWeather, catenary, box } from './geo.js';
import {
  newBag, placeBag, blockhouse, barracks, vehicleShed, bunker, watchtower, gateway, helipad,
} from './buildings.js';
import * as P from './props.js';
import { OutpostGround } from './ground.js';
import { layPerimeter, panelGeo, pilasterGeo, linkPostGeo, linkFabricGeo, sandbagWall, PANEL_H } from './fences.js';
import { chainLinkTexture, camoNetTexture } from './textures.js';

/**
 * A Soviet-era forward outpost, near the world origin.
 *
 * The compound is authored in its own frame (u = "east", v = "south", yaw 17°
 * against world north) so the whole site can be rotated for a three-quarter read
 * from the approach without every placement turning into trigonometry. It sits
 * on a cut-and-fill platform ~7m above the valley floor — which is both what a
 * real engineer battalion would do and what gives the place the vertical layering
 * that makes MGSV outposts readable from the approach: you can see the wall line,
 * the towers over it, and the roofs over those, all at once.
 *
 * Layout intent:
 *   - one gate, facing the approach track, covered by a tower and a boom
 *   - a vehicle yard immediately inside it (the loud, open part)
 *   - a quiet residential street of barracks behind the yard (the flanking route)
 *   - the command block at the back, with the mast and the dishes (the objective)
 *   - continuous perimeter with two soft spots: chain-link runs, not concrete
 */

const THETA = 0.30; // compound yaw, local -> world
const PAD_Y = 0.0; // finished level of the platform

// Compound extent in local space. The wall runs the perimeter of this rectangle.
const RECT = { u0: -46, u1: 42, v0: -42, v1: 36, cu0: -2, cv0: -3 };
const GATE = { u: 14.4, v: RECT.v1, gap: 9 };

export async function install(world) {
  const rng = makeRng(0x5eed1917);
  const group = new THREE.Group();
  group.name = 'outpost';
  group.rotation.y = THETA;
  world.scene.add(group);

  // ---------------------------------------------------------------- ground --
  const roads = [
    {
      // Access track: yard -> gate -> down the ramp -> out across the plain.
      pts: [
        [2, -6], [8, 2], [12, 12], [13.5, 24], [14.4, 36],
        [19.2, 53], [25.6, 72.8], [33.1, 96], [42.6, 126.2],
        [54, 160], [66, 196], [80, 240], [98, 292],
      ],
      width: 7.4,
      // `length` is overwritten by OutpostGround once it has measured the fill.
      corridor: { halfWidth: 9.5, s0: 44.9, length: 120 },
    },
    { pts: [[2, -6], [-6, -4], [-18, -3], [-30, -2], [-41, -1]], width: 5.4 },
    { pts: [[12, 12], [21, 6], [28, 2]], width: 5.2 },
    { pts: [[8, 2], [-6, 8], [-18, 12], [-29, 14]], width: 4.4 },
    { pts: [[13.5, 24], [26, 20], [34, 14]], width: 4.8 },
    {
      // Interior patrol road hugging the wall — reads from the air, and gives the
      // AI module an unambiguous perimeter route.
      pts: [
        [8, 32.5], [-10, 33.5], [-30, 33], [-40, 31], [-42, 14], [-42, -10], [-40, -36],
        [-20, -38], [10, -38.5], [36, -37], [38, -18], [38, 8], [36, 31],
      ],
      width: 3.6,
    },
  ];
  const paths = [
    { pts: [[-34.7, -5.5], [-28, -4.2], [-16, -4], [-6, -6], [0, -12], [2, -18]], width: 1.5 },
    { pts: [[-33.2, 12.3], [-29, 8], [-25, 2], [-24, -2]], width: 1.4 },
    { pts: [[16, 10], [23, 5], [28, 1]], width: 1.3 },
    { pts: [[-29, 14], [-21, 12], [-11, 9]], width: 1.2 },
    { pts: [[2, -18], [-12, -34], [-30, -33]], width: 1.15 },
  ];
  const hardstand = [
    { cu: 17, cv: 16, hu: 19, hv: 15 },
    { cu: 28, cv: 3, hu: 12, hv: 7 },
    { cu: -24, cv: -3, hu: 16, hv: 5 },
    { cu: 2, cv: -16, hu: 12, hv: 5 },
    { cu: -23, cv: 20, hu: 10, hv: 7.5 },
    { cu: -30, cv: 15, hu: 12, hv: 12 },
  ];
  const oil = [
    { u: 28, v: 3, r: 2.8 }, { u: 24, v: 6, r: 1.7 }, { u: 31, v: 0.5, r: 1.9 },
    { u: 18, v: 18, r: 2.3 }, { u: 12, v: 22, r: 1.5 }, { u: 26, v: 17, r: 2.0 },
    { u: 8, v: -14, r: 1.6 }, { u: -20, v: -3, r: 1.4 },
    { u: -22, v: 19, r: 2.1 }, { u: -26, v: 22.5, r: 1.5 },
  ];
  const mounds = [
    { u: -38, v: -33, r: 13, h: 1.35 },
    { u: -41, v: -12, r: 6.5, h: 0.7 },
    { u: 34, v: -30, r: 7.5, h: 0.85 },
    { u: 58, v: 8, r: 15, h: 2.4 },
    { u: -60, v: 4, r: 17, h: 2.9 },
    { u: 4, v: -60, r: 16, h: 2.2 },
    { u: 26, v: 52, r: 13, h: 1.7 },
    { u: -34, v: 50, r: 12, h: 1.9 },
  ];

  const ground = new OutpostGround({
    terrain: world.terrain, theta: THETA, padY: PAD_Y,
    rect: { cu: (RECT.u0 + RECT.u1) / 2, cv: (RECT.v0 + RECT.v1) / 2, hu: (RECT.u1 - RECT.u0) / 2, hv: (RECT.v1 - RECT.v0) / 2 },
    roads, paths, hardstand, oil, mounds, skirt: 28, apron: 7,
  });
  /** Finished ground height at a compound-local point. */
  const gy = (u, v) => {
    const [x, z] = ground.toWorld(u, v);
    return ground.heightAtLocal(u, v, x, z);
  };

  // -------------------------------------------------------------- materials --
  const linkTex = chainLinkTexture();
  const netTex = camoNetTexture();
  const M = {
    concrete: createSurface({
      mode: MODE.CONCRETE, name: 'op-concrete',
      color: [0.345, 0.338, 0.312], color2: [0.212, 0.207, 0.192], color3: [0.470, 0.458, 0.420],
      rust: [0.30, 0.155, 0.08], wear: 0.42, dustAmt: 0.34, scale: 1.0, roughness: 0.93, envMapIntensity: 1.45,
    }),
    // Broken slab and rubble. It lies in the dirt, so it must read *darker* than
    // the hardstanding it sits on. On the shared concrete material a tumbling
    // chunk presents almost nothing but up-faces, which collect both the
    // sun-bleach term and the full dust film and end up brighter than the road —
    // a scatter of white paper across the yard.
    debris: createSurface({
      mode: MODE.CONCRETE, name: 'op-debris',
      color: [0.196, 0.190, 0.172], color2: [0.128, 0.124, 0.114], color3: [0.250, 0.242, 0.220],
      rust: [0.26, 0.13, 0.06], wear: 0.85, dustAmt: 0.20, scale: 3.2, roughness: 0.96, envMapIntensity: 1.1,
    }),
    wall: createSurface({
      mode: MODE.CONCRETE, name: 'op-wall',
      color: [0.368, 0.358, 0.328], color2: [0.222, 0.216, 0.200], color3: [0.500, 0.485, 0.442],
      rust: [0.30, 0.155, 0.08], wear: 0.62, dustAmt: 0.40, scale: 1.25, roughness: 0.94, envMapIntensity: 1.45,
    }),
    metal: createSurface({
      mode: MODE.METAL, name: 'op-metal',
      color: [0.086, 0.098, 0.062], color2: [0.135, 0.140, 0.132], color3: [0.075, 0.098, 0.115],
      rust: [0.255, 0.115, 0.048], wear: 0.50, dustAmt: 0.26, metalness: 0.62, roughness: 0.55, scale: 1.6, envMapIntensity: 1.2,
    }),
    corr: createSurface({
      mode: MODE.CORRUGATED, name: 'op-corr',
      color: [0.185, 0.190, 0.178], color2: [0.128, 0.148, 0.112], color3: [0.245, 0.225, 0.185],
      rust: [0.245, 0.108, 0.045], wear: 0.60, dustAmt: 0.30, metalness: 0.55, roughness: 0.62,
      corrFreq: 21.0, corrAmp: 0.68, scale: 1.2, envMapIntensity: 1.3,
    }),
    wood: createSurface({
      mode: MODE.WOOD, name: 'op-wood',
      color: [0.068, 0.054, 0.036], color2: [0.108, 0.086, 0.056], color3: [0.128, 0.122, 0.108],
      rust: [0.22, 0.12, 0.05], wear: 0.55, dustAmt: 0.30, roughness: 0.92, scale: 1.0, envMapIntensity: 1.4,
    }),
    cloth: createSurface({
      mode: MODE.CLOTH, name: 'op-cloth',
      color: [0.158, 0.143, 0.104], color2: [0.100, 0.092, 0.070], color3: [0.212, 0.194, 0.142],
      wear: 0.45, dustAmt: 0.30, roughness: 0.97, scale: 1.6, side: THREE.DoubleSide, envMapIntensity: 1.25,
    }),
    rubber: createSurface({
      mode: MODE.CLOTH, name: 'op-rubber',
      color: [0.032, 0.031, 0.030], color2: [0.052, 0.050, 0.048], color3: [0.075, 0.073, 0.070],
      wear: 0.3, dustAmt: 0.34, roughness: 0.86, scale: 3.0,
    }),
    paint: createSurface({
      mode: MODE.CONCRETE, name: 'op-paint',
      color: [0.535, 0.520, 0.470], color2: [0.335, 0.328, 0.305], color3: [0.660, 0.645, 0.590],
      rust: [0.30, 0.155, 0.08], wear: 1.05, dustAmt: 0.45, scale: 1.6, roughness: 0.90,
    }),
    paintWarn: createSurface({
      mode: MODE.METAL, name: 'op-paintwarn',
      color: [0.235, 0.032, 0.020], color2: [0.175, 0.028, 0.018], color3: [0.290, 0.058, 0.032],
      rust: [0.24, 0.105, 0.045], wear: 0.72, dustAmt: 0.38, metalness: 0.10, roughness: 0.72, scale: 1.8,
    }),
    link: createSurface({
      mode: MODE.METAL, name: 'op-link', map: linkTex, alphaTest: 0.30, side: THREE.DoubleSide,
      color: [0.60, 0.615, 0.615], color2: [0.42, 0.425, 0.415], color3: [0.70, 0.705, 0.690],
      rust: [0.30, 0.135, 0.055], wear: 0.60, dustAmt: 0.16, metalness: 0.70, roughness: 0.52, scale: 2.0,
    }),
    net: createSurface({
      mode: MODE.CLOTH, name: 'op-net', map: netTex, alphaTest: 0.42, side: THREE.DoubleSide,
      color: [0.400, 0.362, 0.245], color2: [0.245, 0.238, 0.172], color3: [0.330, 0.352, 0.215],
      wear: 0.5, dustAmt: 0.40, roughness: 0.97, scale: 1.0, envMapIntensity: 1.5,
    }),
    ground: createSurface({
      mode: MODE.GROUND, name: 'op-ground',
      color: [0.372, 0.322, 0.240], color2: [0.238, 0.202, 0.148], color3: [0.182, 0.176, 0.164],
      wear: 0.4, dustAmt: 0.0, roughness: 0.95, scale: 1.0, envMapIntensity: 1.3,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x0a0c0d, roughness: 0.22, metalness: 0.05, envMapIntensity: 1.5, name: 'op-glass',
    }),
  };
  // Glazing that lights up; emissive is driven from the time of day below.
  M.glow = new THREE.MeshStandardMaterial({
    color: 0x07070a, roughness: 0.4, metalness: 0.0, name: 'op-glow',
    emissive: new THREE.Color().setRGB(1.0, 0.60, 0.26, THREE.LinearSRGBColorSpace),
    emissiveIntensity: 0.0,
  });
  M.lamp = new THREE.MeshStandardMaterial({
    color: 0x101010, roughness: 0.35, metalness: 0.2, name: 'op-lamp',
    emissive: new THREE.Color().setRGB(1.0, 0.78, 0.48, THREE.LinearSRGBColorSpace),
    emissiveIntensity: 0.0,
  });

  const R = ground.reach;
  const groundMesh = new THREE.Mesh(ground.build({
    u0: RECT.u0 - R, u1: RECT.u1 + R, v0: RECT.v0 - R, v1: Math.max(RECT.v1 + R, 250), step: 1.5,
  }), M.ground);
  groundMesh.receiveShadow = true;
  groundMesh.castShadow = true;
  groundMesh.name = 'outpost-pad';
  group.add(groundMesh);

  // ---------------------------------------------------------- architecture --
  const bag = newBag();
  const put = (built, u, v, ry = 0, dy = 0) => placeBag(bag, built, { u, v, y: gy(u, v) + dy, ry });

  put(barracks({ w: 26, d: 10, rng, litFrac: 0.45 }), -24, -12, 0);
  put(barracks({ w: 23, d: 9.5, rng, litFrac: 0.35 }), -24, 6, Math.PI);
  const BLOCK = { u: 2, v: -27, w: 18, d: 13, storeys: 2 };
  put(blockhouse({ w: BLOCK.w, d: BLOCK.d, storeys: BLOCK.storeys, rng, litFrac: 0.5 }), BLOCK.u, BLOCK.v, 0);
  put(vehicleShed({ w: 16, d: 12, bays: 3 }), 28, -6, 0);
  put(bunker({ w: 12, d: 8 }), -38, -30, 0.34);
  const TOWER_A = { u: 36, v: 29, h: 9.0 };
  const TOWER_B = { u: -42, v: -37, h: 11.5 };
  put(watchtower({ h: TOWER_A.h }), TOWER_A.u, TOWER_A.v, -2.35);
  put(watchtower({ h: TOWER_B.h }), TOWER_B.u, TOWER_B.v, 0.75);
  put(gateway({ gap: GATE.gap }), GATE.u, GATE.v, 0);
  const PAD = { u: -30, v: 15 };
  put(helipad({ r: 9.5 }), PAD.u, PAD.v, 0.4);

  // ------------------------------------------------------------- perimeter --
  const corners = [
    [RECT.u0, RECT.v0], [RECT.u1, RECT.v0], [RECT.u1, RECT.v1], [RECT.u0, RECT.v1],
  ];
  const peri = layPerimeter({
    corners,
    gaps: [{ u: GATE.u, v: GATE.v, r: GATE.gap / 2 + 1.6 }],
    linkRuns: [
      { edge: 0, t0: 0.52, t1: 0.86 },
      { edge: 3, t0: 0.12, t1: 0.42 },
      { edge: 1, t0: 0.72, t1: 0.88 },
    ],
    groundY: gy,
    rng,
  });

  // -------------------------------------------------------------- dressing --
  const cover = [];
  const guardPosts = [];
  const pos = (u, v, dy = 0) => new THREE.Vector3(u, gy(u, v) + dy, v);
  const at = (u, v, ry = 0, extra = {}) => ({ pos: pos(u, v, extra.dy ?? 0), ry, ...extra });

  // Shipping containers: cover, and the vertical break the yard needs.
  const containers = [
    at(31, 15.5, 0.08), at(31, 15.5, 0.11, { dy: 2.72 }), at(31, 20.6, -0.05),
    at(23.5, 24, 1.62), at(-2, 27, 0.34), at(-2, 27, 0.30, { dy: 2.72 }),
    at(-9, 25.4, -0.18), at(38, -19, 1.55), at(38, -24.4, 1.51), at(-41, 9, 0.92),
    at(-11.5, 2.5, 1.48), at(-11.5, 2.5, 1.51, { dy: 2.72 }), at(11.5, -6.5, 0.22),
    at(-42, -22, 0.06), at(-42, -27.2, 0.09), at(-26, -37, 1.62), at(20, -34, 0.14),
  ];
  for (const c of containers) cover.push({ u: c.pos.x, v: c.pos.z, r: 3.4 });

  const drums = [];
  const drumClusters = [
    [30, 8, 12], [26.5, 11, 7], [-12.5, -8.5, 9], [-40, 3, 8], [4, -20, 7],
    [-33, -26, 10], [17, 27, 6], [-9, -16.5, 6], [35.5, 4, 5],
    [-6.5, 6.0, 8], [8.5, -1.5, 7], [19, 45, 6], [-2.5, 2.5, 6], [4.5, -6.5, 5],
    [-36, -20, 8], [-20, -33, 7], [24, -28, 6],
  ];
  for (const [cu, cv, n] of drumClusters) {
    for (let i = 0; i < n; i++) {
      const side = rng.chance(0.18);
      const u = cu + rng.jitter(2.4);
      const v = cv + rng.jitter(2.0);
      const stack = !side && rng.chance(0.22) ? 0.885 : 0;
      drums.push({
        pos: pos(u, v, side ? 0.293 : stack),
        ry: rng.range(0, 6.28),
        rz: side ? Math.PI / 2 : 0,
        rx: side ? 0 : rng.jitter(0.02),
        wear: rng.range(0.2, 1.0),
      });
    }
    cover.push({ u: cu, v: cv, r: 2.4 });
  }

  const crates = [];
  const pallets = [];
  const jerry = [];
  const dumps = [[-11, -13], [-32, 18], [12, -18], [33, -27], [-22, 20], [5.0, 3.0], [-38, -14], [-24, -34]];
  for (const [cu, cv] of dumps) {
    for (let i = 0; i < 7; i++) {
      const u = cu + rng.jitter(2.6);
      const v = cv + rng.jitter(2.2);
      pallets.push(at(u, v, rng.range(0, 6.28)));
      const stackN = rng.int(1, 2);
      for (let s = 0; s < stackN; s++) {
        crates.push({
          pos: pos(u + rng.jitter(0.12), v + rng.jitter(0.12), 0.21 + s * 0.78),
          ry: rng.range(0, 6.28) * (s ? 0.02 : 1) + rng.jitter(0.08),
          scale: rng.range(0.88, 1.06),
          wear: rng.range(0.1, 0.9),
        });
      }
    }
    for (let i = 0; i < 9; i++) {
      jerry.push(at(cu + rng.jitter(3.0), cv + rng.jitter(2.6), rng.range(0, 6.28)));
    }
    cover.push({ u: cu, v: cv, r: 3.0 });
  }

  const tyres = [];
  for (const [cu, cv] of [[33, 8.5], [-16, -6], [25, -12], [-4.5, 1.5], [9.5, 8.0]]) {
    for (let s = 0; s < 4; s++) {
      tyres.push({ pos: pos(cu, cv, s * 0.29), ry: rng.range(0, 6.28), rx: rng.jitter(0.03) });
    }
    for (let i = 0; i < 3; i++) {
      tyres.push(at(cu + rng.jitter(2.2), cv + rng.jitter(1.8), rng.range(0, 6.28)));
    }
  }

  // Rubble and broken slab where the plant has chewed the edges up.
  const rubble = [];
  for (let i = 0; i < 420; i++) {
    const u = rng.range(RECT.u0 - 34, RECT.u1 + 34);
    const v = rng.range(RECT.v0 - 30, RECT.v1 + 46);
    const k = ground.padK(u, v);
    if (k < 0.08) continue;
    if (k < 0.9 && rng.chance(0.45)) continue;
    rubble.push({
      pos: pos(u, v, -0.04), ry: rng.range(0, 6.28), rx: rng.jitter(0.25), rz: rng.jitter(0.25),
      scale: rng.range(0.35, 1.25),
    });
  }

  // Debris thrown clear of the ramp by thirty years of traffic.
  for (let i = 0; i < 260; i++) {
    const t = rng.range(0, 1);
    const road = roads[0].pts;
    const seg = Math.min(road.length - 2, Math.floor(3 + t * (road.length - 5)));
    const f = rng();
    const u0 = road[seg][0] + (road[seg + 1][0] - road[seg][0]) * f;
    const v0 = road[seg][1] + (road[seg + 1][1] - road[seg][1]) * f;
    const off = (rng.chance(0.5) ? 1 : -1) * rng.range(4.5, 17);
    const u = u0 + off * 0.95;
    const v = v0 - off * 0.3;
    if (ground.padK(u, v) < 0.05) continue;
    rubble.push({
      pos: pos(u, v, -0.04), ry: rng.range(0, 6.28), rx: rng.jitter(0.3), rz: rng.jitter(0.3),
      scale: rng.range(0.3, 1.5),
    });
  }

  // Concrete barriers making a chicane through the gate.
  const barriers = [];
  for (const [u, v, r] of [
    [8.5, 30.5, 0.1], [8.9, 28.5, 0.08], [20.5, 31.5, -0.06], [20.9, 29.5, 0.04],
    [12, 24, 1.55], [16, 22.4, 1.6], [30, 26, 0.2], [32, 24, 0.25], [-3, 20, 1.5], [-3, 22, 1.52],
    [7.5, 1.0, 0.9], [9.2, -0.6, 0.95], [-7.0, 9.5, 2.3], [17.8, 46.5, 0.28], [19.4, 44.2, 0.3],
    [14.0, 43.0, 0.32], [15.6, 40.8, 0.34],
  ]) {
    barriers.push(at(u, v, r));
    cover.push({ u, v, r: 1.6 });
  }
  const pipes = [];
  for (const [u, v, r] of [[-14, 16, 0.6], [-14.3, 17.4, 0.62], [22, -18, 2.1], [-13.5, 3.0, 1.35], [-13.9, 4.6, 1.3]]) {
    pipes.push(at(u, v, r));
    cover.push({ u, v, r: 1.5 });
  }

  // Sandbag emplacements: gate flanks, a yard nest, tower bases, roof position.
  const sandbags = [];
  const emplacements = [
    { pts: [[2.4, 32.6], [7.4, 31.0]], courses: 8 },
    { pts: [[26.6, 32.6], [21.6, 31.0]], courses: 8 },
    { pts: [[-8.6, 10.6], [-2.4, 9.2]], courses: 8 },
    { pts: [[TOWER_B.u + 3.2, TOWER_B.v + 2.4], [TOWER_B.u + 3.4, TOWER_B.v - 2.2]], courses: 7 },
    { pts: [[39.5, -7.0], [39.5, -12.6]], courses: 7 },
    { pts: [[-35.5, 33.4], [-30.4, 33.0]], courses: 7 },
    { pts: [[11.4, 47.8], [16.6, 45.4]], courses: 7 },
    { pts: [[8.4, -6.2], [12.6, -1.8]], courses: 8 },
  ];
  for (const e of emplacements) {
    for (const b2 of sandbagWall({ pts: e.pts, courses: e.courses, rng, groundY: gy })) sandbags.push(b2);
    guardPosts.push({ u: e.pts[0][0], v: e.pts[0][1], kind: 'emplacement' });
    for (const p of e.pts) cover.push({ u: p[0], v: p[1], r: 1.4 });
  }
  // Roof position on the command block: same generator, lifted to the parapet.
  {
    const roofY = gy(BLOCK.u, BLOCK.v) + BLOCK.storeys * 3.2 + 0.34;
    const flat = () => roofY;
    for (const b2 of sandbagWall({
      pts: [[BLOCK.u - 5, BLOCK.v + 4.4], [BLOCK.u + 3, BLOCK.v + 4.4]], courses: 3, rng, groundY: flat,
    })) sandbags.push(b2);
    guardPosts.push({ u: BLOCK.u - 1, v: BLOCK.v + 3.2, y: roofY, kind: 'roof' });
  }

  // Floodlights, high mast, radio mast, dishes.
  const floods = [
    at(6.5, 27.5, 3.3), at(-13, -2, 1.1), at(30.5, -16.5, 2.4),
    at(-35, 4, -1.2), at(-1, -18.5, 0.4), at(34, 9.5, 2.9), at(-30, 31, 2.2),
  ];
  const HIGH_MAST = { u: 18.5, v: -4.5, h: 13 };
  const MAST = { u: -12, v: -34, h: 19 };

  // Cable runs between the poles and the buildings — reads as a wired-up site.
  const cables = [];
  const cableRuns = [
    [[6.5, 27.5, 6.2], [-1, -18.5, 6.2]],
    [[-1, -18.5, 6.2], [-13, -2, 6.2]],
    [[-13, -2, 6.2], [-35, 4, 6.2]],
    [[6.5, 27.5, 6.2], [34, 9.5, 6.2]],
    [[34, 9.5, 6.2], [30.5, -16.5, 6.2]],
    [[-1, -18.5, 5.4], [BLOCK.u, BLOCK.v + BLOCK.d / 2, 5.6]],
    [[-13, -2, 5.4], [-24, -12 + 5.2, 3.0]],
  ];
  for (const [a, b2] of cableRuns) {
    const A = new THREE.Vector3(a[0], gy(a[0], a[1]) + a[2], a[1]);
    const B = new THREE.Vector3(b2[0], gy(b2[0], b2[1]) + b2[2], b2[1]);
    cables.push(catenary(A, B, Math.min(1.5, A.distanceTo(B) * 0.045), 0.026, 14));
  }
  for (const g of cables) bakeWeather(g, { wear: 0.9 });
  bag.metal.push(...cables);

  // Camo nets: one over the supply dump in the middle of the compound (the
  // dappled shade under it is the single best-looking thing on the site), one
  // over the ready vehicles by the gate.
  const nets = [];
  const netBags = [];
  for (const [u, v, w, d, ry] of [[-11.5, -13, 13, 9.5, 0.12], [21.5, 24, 11, 8, 1.62], [-38, -14, 10, 8, 0.5]]) {
    const nb = P.camoNet({ w, d, h: 3.75, sag: 0.75 });
    const dst = newBag();
    placeBag(dst, nb, { u, v, y: gy(u, v), ry });
    netBags.push(dst);
    nets.push({ u, v });
  }

  const tarps = [];
  for (const [u, v, ry] of [[-13, -15, 0.3], [-31, 19, 1.2], [13, -19.5, 2.2], [4.0, 6.0, 0.9], [-40, -19, 1.9], [-22, -31, 0.4]]) {
    const tb = P.tarpGeo({ w: 2.8, d: 2.2, h: 1.35 });
    const dst = newBag();
    placeBag(dst, tb, { u, v, y: gy(u, v) + 0.2, ry });
    netBags.push(dst);
    tarps.push({ u, v });
  }

  // -------------------------------------------------------------- assembly --
  const staticMeshes = [];
  const addMerged = (geos, mat, name, { cast = true, receive = true } = {}) => {
    const g = merge(geos);
    if (!g) return null;
    const m = new THREE.Mesh(g, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.name = name;
    group.add(m);
    staticMeshes.push(m);
    return m;
  };

  for (const nb of netBags) for (const k of Object.keys(nb)) (bag[k] ??= []).push(...nb[k]);

  addMerged(bag.concrete, M.concrete, 'op-arch-concrete');
  addMerged(bag.metal, M.metal, 'op-arch-metal');
  addMerged(bag.corr, M.corr, 'op-arch-corr');
  addMerged(bag.wood, M.wood, 'op-arch-wood');
  addMerged(bag.cloth, M.cloth, 'op-arch-cloth');
  addMerged(bag.net, M.net, 'op-arch-net', { receive: false });
  addMerged(bag.rubber, M.rubber, 'op-arch-rubber');
  addMerged(bag.glass, M.glass, 'op-arch-glass', { cast: false });
  addMerged(bag.glow, M.glow, 'op-arch-glow', { cast: false });
  addMerged(bag.paint, M.paint, 'op-arch-paint');
  addMerged(bag.paintWarn, M.paintWarn, 'op-arch-paintwarn');

  // Perimeter.
  const panelBag = panelGeo();
  const pilBag = pilasterGeo();
  const linkPostBag = linkPostGeo();
  const addInst = (geos, list, matMap, opts = {}) => {
    if (!list.length) return;
    const vars = makeVars(list, rng, opts.wearAmp ?? 0.45);
    for (const [k, g] of Object.entries(geos)) {
      const mesh = instanced(g, matMap[k], list, rng, { ...opts, vars });
      if (mesh) group.add(mesh);
    }
  };
  addInst({ concrete: merge(panelBag.concrete) }, peri.panels, { concrete: M.wall });
  addInst({ concrete: merge(pilBag.concrete), metal: merge(pilBag.metal) }, peri.pilasters, { concrete: M.wall, metal: M.metal });
  addInst(
    { metal: merge(linkPostBag.metal), concrete: merge(linkPostBag.concrete) },
    peri.linkPosts, { metal: M.metal, concrete: M.wall },
  );
  addMerged(linkFabricGeo(peri.linkFabric), M.link, 'op-linkfabric', { cast: true, receive: false });
  addMerged(peri.razor.map((g) => bakeWeather(g, { wear: 1.0 })), M.metal, 'op-razor', { receive: false });
  addMerged(peri.railGeo.map((g) => bakeWeather(g, { wear: 0.9 })), M.metal, 'op-linkrail');

  // Chain-link infill on the gate leaves.
  const gateFabric = [];
  for (const leaf of bag.interest.filter((i) => i.kind === 'gateleaf')) {
    gateFabric.push({ u: leaf.pos.x, v: leaf.pos.z, ry: leaf.ry, w: leaf.span - 0.1, y: leaf.pos.y - 1.22 });
  }
  addMerged(linkFabricGeo(gateFabric, { h: 2.5 }), M.link, 'op-gatefabric', { receive: false });

  // Props.
  const matMap = {
    concrete: M.concrete, metal: M.metal, corr: M.corr, wood: M.wood, cloth: M.cloth,
    net: M.net, rubber: M.rubber, glass: M.glass, glow: M.lamp, paint: M.paint, paintWarn: M.paintWarn,
  };
  addInst(P.bagToGeos(P.containerGeo()), containers, matMap, { wearAmp: 0.8 });
  addInst(P.bagToGeos(P.drumGeo()), drums, matMap, { wearAmp: 0.9 });
  addInst(P.bagToGeos(P.crateGeo()), crates, matMap, { wearAmp: 0.7 });
  addInst(P.bagToGeos(P.palletGeo()), pallets, matMap, { wearAmp: 0.8 });
  addInst(P.bagToGeos(P.jerryCanGeo()), jerry, matMap, { wearAmp: 0.9 });
  addInst(P.bagToGeos(P.tyreGeo()), tyres, matMap, { wearAmp: 0.5 });
  addInst(P.bagToGeos(P.rubbleGeo(7)), rubble, { ...matMap, concrete: M.debris }, { wearAmp: 1.0, cast: true });
  addInst(P.bagToGeos(P.barrierGeo()), barriers, matMap, { wearAmp: 0.8 });
  addInst(P.bagToGeos(P.pipeGeo()), pipes, matMap, { wearAmp: 0.8 });
  addInst(P.bagToGeos(P.sandbagGeo()), sandbags, matMap, { wearAmp: 0.5 });

  const floodGeos = P.bagToGeos(P.floodlightGeo({ h: 6.4 }));
  addInst(floodGeos, floods, matMap, { wearAmp: 0.6 });
  addInst(P.bagToGeos(P.floodlightLensGeo({ h: 6.4 })), floods, matMap, { cast: false });

  const mastList = [at(HIGH_MAST.u, HIGH_MAST.v)];
  addInst(P.bagToGeos(P.highMastGeo({ h: HIGH_MAST.h })), mastList, matMap, { wearAmp: 0.4 });
  addInst(P.bagToGeos(P.highMastLensGeo({ h: HIGH_MAST.h })), mastList, matMap, { cast: false });
  addInst(P.bagToGeos(P.antennaMastGeo({ h: MAST.h })), [at(MAST.u, MAST.v, 0.4)], matMap, { wearAmp: 0.4 });
  addInst(P.bagToGeos(P.waterTowerGeo({ h: 10.5 })), [at(-2.5, 20.5, 0.5)], matMap, { wearAmp: 0.5 });
  addInst(P.bagToGeos(P.fuelTankGeo({})), [
    at(36.5, -1.5, 1.60), at(36.5, -6.2, 1.58), at(-38.5, 12.5, 0.35),
  ], matMap, { wearAmp: 0.9 });

  const roofY = gy(BLOCK.u, BLOCK.v) + BLOCK.storeys * 3.2 + 0.34;
  addInst(P.bagToGeos(P.dishGeo({ r: 1.5 })), [
    { pos: new THREE.Vector3(BLOCK.u + 5.4, roofY, BLOCK.v - 3.2), ry: 2.1 },
    { pos: new THREE.Vector3(BLOCK.u - 4.2, roofY, BLOCK.v - 4.0), ry: 2.5, scale: 0.72 },
    at(-33, -22, 1.2, { scale: 0.8 }),
  ], matMap, { wearAmp: 0.4 });

  addInst(P.bagToGeos(P.truckGeo({ tilt: true })), [
    at(26.5, 18.5, 2.42), at(-2, -19.5, 0.32),
  ], matMap, { wearAmp: 0.5 });
  addInst(P.bagToGeos(P.truckGeo({ tilt: false })), [
    at(30.5, 3.5, 0.06), at(21.8, 24.5, 1.60), at(27.5, 57, 1.15),
  ], matMap, { wearAmp: 0.9 });

  // Telegraph line beside the access track. Poles are the cheapest possible way
  // to make an approach read as a road to somewhere.
  const poleAt = [[10.5, 33], [12.5, 45], [17.5, 62], [23, 80], [29, 100], [36, 122], [46, 158]];
  addInst(P.bagToGeos(P.telegraphPoleGeo({ h: 8.2 })), poleAt.map(([u, v]) => at(u, v, 0.1 + u * 0.01)), matMap, { wearAmp: 0.7 });
  const lineGeo = [];
  for (let i = 0; i < poleAt.length - 1; i++) {
    const [au, av] = poleAt[i];
    const [bu, bv] = poleAt[i + 1];
    for (const [ox, oy] of [[-0.82, 7.7], [0.82, 7.7], [-0.58, 6.85], [0.58, 6.85]]) {
      lineGeo.push(catenary(
        new THREE.Vector3(au + ox, gy(au, av) + oy, av),
        new THREE.Vector3(bu + ox, gy(bu, bv) + oy, bv),
        Math.hypot(bu - au, bv - av) * 0.055, 0.022, 10,
      ));
    }
  }
  addMerged(lineGeo.map((g) => bakeWeather(g, { wear: 0.9 })), M.metal, 'op-telegraph', { receive: false });

  // Bulkhead lamps down the inside of the perimeter wall.
  const lampList = [];
  for (let i = 2; i < peri.pilasters.length; i += 5) {
    const pl = peri.pilasters[i];
    const du = RECT.cu0 - pl.pos.x;
    const dv = RECT.cv0 - pl.pos.z;
    lampList.push({
      pos: new THREE.Vector3(pl.pos.x, pl.pos.y + 2.55, pl.pos.z),
      ry: Math.atan2(du, dv),
      wear: 0.7,
    });
  }
  addInst(P.bagToGeos(P.wallLampGeo()), lampList, matMap, { wearAmp: 0.5 });
  addInst(P.bagToGeos(P.wallLampLensGeo()), lampList, matMap, { cast: false });

  // ---------------------------------------------------------------- lights --
  const lights = [];
  const addLight = (l, base) => {
    l.userData.baseIntensity = base;
    l.intensity = 0;
    l.visible = false;
    group.add(l);
    lights.push(l);
    return l;
  };
  const spotAt = (u, v, h, tu, tv, { angle = 0.75, penumbra = 0.55, base = 120, shadow = false, color = 0xffb066, dist = 60 }) => {
    const s = new THREE.SpotLight(color, 0, dist, angle, penumbra, 2.0);
    s.position.set(u, gy(u, v) + h, v);
    s.target.position.set(tu, gy(tu, tv), tv);
    group.add(s.target);
    if (shadow) {
      // Every shadowed spot is a whole extra scene depth pass. Kept off until
      // it is properly dark (see the day/night system below): at dusk the sun
      // still owns the frame and a 38%-intensity lamp pool has no shadow to
      // show, but the pass cost the same 90 draw calls as at midnight.
      s.userData.wantsShadow = true;
      s.castShadow = false;
      s.shadow.mapSize.set(1024, 1024);
      s.shadow.camera.near = 1.5;
      s.shadow.camera.far = dist;
      s.shadow.bias = -0.0016;
      s.shadow.normalBias = 0.05;
    }
    return addLight(s, base);
  };

  // High mast over the vehicle yard: the one big pool, and the one shadow caster.
  spotAt(HIGH_MAST.u, HIGH_MAST.v, HIGH_MAST.h, HIGH_MAST.u + 1, HIGH_MAST.v + 4, {
    angle: 0.86, penumbra: 0.5, base: 900, shadow: true, dist: 70, color: 0xffc27a,
  });
  // Floodlights on poles, aimed where a sentry would want them. None of them
  // casts: one shadowed pool (the mast, above) is enough to sell the yard, and
  // a second cost a full scene depth pass for a 34 m cone.
  const floodAim = [
    [6.5, 27.5, 14, 33], [-13, -2, -22, -6], [30.5, -16.5, 24, -10],
    [-35, 4, -30, 14], [-1, -18.5, 4, -26], [34, 9.5, 40, 20], [-30, 31, -22, 28],
  ];
  for (let i = 0; i < floodAim.length; i++) {
    const [u, v, tu, tv] = floodAim[i];
    spotAt(u, v, 6.6, tu, tv, {
      angle: 0.58, penumbra: 0.5, base: i === 1 ? 230 : (i === 6 ? 90 : 155), dist: 34,
      color: 0xffb268,
    });
  }
  // Tower searchlights: long, narrow throw across the approach.
  spotAt(TOWER_A.u, TOWER_A.v, TOWER_A.h + 3.4, 6, 62, { angle: 0.22, penumbra: 0.45, base: 2600, dist: 130, color: 0xfff0d0 });
  spotAt(TOWER_B.u, TOWER_B.v, TOWER_B.h + 3.4, 6, -8, { angle: 0.19, penumbra: 0.5, base: 2400, dist: 120, color: 0xfff0d0 });

  // Doorway and helipad fill.
  for (const [u, v, h, base] of [[GATE.u - 8, GATE.v - 1.2, 3.1, 26], [PAD.u + 4, PAD.v + 6, 3.6, 9], [-24, -6.5, 2.8, 20], [28, 0.5, 4.3, 30]]) {
    const p = new THREE.PointLight(0xffb673, 0, 24, 2.0);
    p.position.set(u, gy(u, v) + h, v);
    addLight(p, base);
  }

  // Small emissive markers: helipad edge lights and mast obstruction lights.
  const markers = [];
  for (const l of bag.lights.filter((x) => x.kind === 'padlight')) {
    markers.push({ pos: l.pos.clone(), ry: 0, scale: 1 });
  }
  markers.push({ pos: new THREE.Vector3(MAST.u, gy(MAST.u, MAST.v) + MAST.h + 3.3, MAST.v), ry: 0, scale: 1.6 });
  const markerGeo = new THREE.SphereGeometry(0.07, 6, 4);
  bakeWeather(markerGeo, { wear: 0 });
  const markerMesh = instanced(markerGeo, M.lamp, markers, rng, { cast: false, receive: false });
  if (markerMesh) group.add(markerMesh);

  // ------------------------------------------------- day / night behaviour --
  const glowMats = [M.glow, M.lamp];
  let lastN = -1;
  world.engine.addSystem({
    order: -40,
    update() {
      const el = world.lighting?.preset?.sunElevation ?? 30;
      const n = THREE.MathUtils.clamp((7.0 - el) / 13.0, 0, 1);
      if (Math.abs(n - lastN) < 0.001) return;
      lastN = n;
      for (const l of lights) {
        l.intensity = l.userData.baseIntensity * n;
        // Dropping the light entirely below threshold keeps the daylight shots
        // off the multi-light shader path.
        l.visible = n > 0.02;
        if (l.userData.wantsShadow) l.castShadow = n > 0.55;
      }
      glowMats[0].emissiveIntensity = 2.6 * n;
      glowMats[1].emissiveIntensity = 2.4 * n;
    },
  });

  // ------------------------------------------------------------------- API --
  const toWorldV = (u, v, y = null) => {
    const [x, z] = ground.toWorld(u, v);
    return new THREE.Vector3(x, y ?? gy(u, v), z);
  };

  const guards = [];
  for (const g of guardPosts) guards.push({ position: toWorldV(g.u, g.v, g.y ?? null), kind: g.kind });
  for (const t of [TOWER_A, TOWER_B]) {
    guards.push({ position: toWorldV(t.u, t.v, gy(t.u, t.v) + t.h + 0.2), kind: 'tower' });
  }
  for (const i of bag.interest.filter((x) => x.kind === 'guardpost')) {
    guards.push({ position: toWorldV(i.pos.x, i.pos.z, i.pos.y), kind: 'post' });
  }

  const patrolLoops = [
    [[38, 30], [39, 8], [39, -20], [36, -37], [8, -39], [-20, -38], [-40, -35], [-42, -8], [-41, 14], [-38, 33], [-6, 34], [22, 33]],
    [[14, 28], [11, 12], [2, -4], [-12, -3], [-30, -3], [-33, 8], [-24, 12], [-8, 8], [8, 4], [22, 3], [28, 8], [24, 20]],
    [[2, -18], [-10, -20], [-26, -26], [-33, -22], [-20, -16], [-4, -16]],
  ].map((loop) => loop.map(([u, v]) => toWorldV(u, v)));

  const coverPoints = cover.map((c) => ({ position: toWorldV(c.u, c.v), radius: c.r }));

  const world2local = (x, z) => ground.toLocal(x, z);
  const bounds = new THREE.Box3();
  for (const c of corners) bounds.expandByPoint(toWorldV(c[0], c[1]));
  bounds.min.y = PAD_Y - 12;
  bounds.max.y = PAD_Y + 24;

  const api = {
    group,
    theta: THETA,
    padLevel: PAD_Y,
    bounds,
    /** Finished ground height including the platform, ramp and track. */
    heightAt: (x, z) => ground.heightAt(x, z),
    /** 0 on natural terrain, 1 on the engineered platform — vegetation should thin out on it. */
    developmentAt: (x, z) => {
      const [u, v] = world2local(x, z);
      return ground.padK(u, v);
    },
    isInside(x, z) {
      const [u, v] = world2local(x, z);
      return u > RECT.u0 && u < RECT.u1 && v > RECT.v0 && v < RECT.v1;
    },
    toLocal: world2local,
    toWorld: (u, v) => ground.toWorld(u, v),
    guardPosts: guards,
    patrolWaypoints: patrolLoops,
    coverPoints,
    gate: toWorldV(GATE.u, GATE.v),
    lights,
  };

  // Other modules place things on the ground; make the corrected height easy to
  // find whether they look at the registry or at the world object.
  if (!world.groundHeightAt) world.groundHeightAt = api.heightAt;
  world.registry.outpostGround = api;
  return api;
}
