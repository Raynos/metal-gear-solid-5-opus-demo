/**
 * Headless test bench for the AI, in the style of `characters/_preview.mjs`.
 *
 *   node src/ai/_sim.mjs
 *
 * It builds a stub world — four stub soldiers, a flat ground plane and one 40 m
 * wall — and drives `install()` against it with no WebGL, no browser and no
 * screenshot harness. Every number in this file's output is a design decision
 * that has to be checked after any edit: how long a guard takes to identify a
 * standing man at 25 m, how much longer a prone one takes, whether a wall
 * actually stops him, and where the alert ladder sits after 90 seconds.
 *
 * It exists because the browser harness costs ~30 s per question and the
 * calibration needs about forty of them. Everything geometry-specific — the
 * real compound's occlusion, the real garrison's posts — still has to be
 * measured in the page; this covers the behaviour, not the level.
 */
import * as THREE from 'three';
import { install } from './index.js';

function stubChar(name, x, z, yaw = 0, isPlayer = false) {
  return {
    name, isPlayer, controlled: false,
    position: new THREE.Vector3(x, 0, z),
    yaw, groundY: 0,
    anim: { stance: 'stand', aim: 0, aimTarget: new THREE.Vector3(), lookTarget: null, speed: 0 },
    setStance(s) { this.anim.stance = s; },
    lookAt(v) { this.anim.lookTarget = v; },
    takeHit() {},
    drive(dt, speed, y) {
      this.anim.speed = speed;
      if (y !== undefined) this.yaw = y;
      if (speed > 0.01) {
        this.position.x += -Math.sin(this.yaw) * speed * dt;
        this.position.z += -Math.cos(this.yaw) * speed * dt;
      }
    },
    update() {},
  };
}

const wallGeo = new THREE.BoxGeometry(40, 3, 1.2);
const wallMesh = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial());
wallMesh.position.set(0, 1.5, 0);

async function makeWorld() {
  const systems = [];
  const engine = {
    elapsed: 0,
    camera: new THREE.PerspectiveCamera(),
    systems,
    addSystem(s) { systems.push(s); systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); },
    step(dt) { engine.elapsed += dt; for (const s of systems) s.update(dt, engine); },
  };
  const group = new THREE.Group();
  group.add(wallMesh.clone());
  group.updateMatrixWorld(true);
  const guardsCh = [
    stubChar('g1', 0, 30, Math.PI),
    stubChar('g2', 12, 34, Math.PI),
    stubChar('g3', -14, 33, Math.PI),
    stubChar('g4', 25, 20, Math.PI),
  ];
  const player = stubChar('player', 300, 300, 0, true);
  const world = {
    engine,
    scene: new THREE.Scene(),
    terrain: { heightAt: () => 0, normalAt: () => new THREE.Vector3(0, 1, 0) },
    lighting: { night: 0, sunDirection: new THREE.Vector3(0.4, 0.6, -0.7).normalize() },
    registry: {
      characters: {
        player,
        characters: [player, ...guardsCh],
        ground: { heightAt: () => 0, normalAt: () => new THREE.Vector3(0, 1, 0) },
      },
      outpost: {
        group,
        bounds: new THREE.Box3(new THREE.Vector3(-60, -5, -60), new THREE.Vector3(60, 20, 60)),
        heightAt: () => 0,
        guardPosts: [],
        patrolWaypoints: [[
          new THREE.Vector3(-18, 0, 26), new THREE.Vector3(18, 0, 26),
          new THREE.Vector3(18, 0, 40), new THREE.Vector3(-18, 0, 40),
        ]],
        coverPoints: [
          { position: new THREE.Vector3(6, 0, 20), radius: 2 },
          { position: new THREE.Vector3(-8, 0, 22), radius: 2 },
        ],
      },
      gameplay: { noiseLevel: 0 },
    },
  };
  const ai = await install(world);
  return { world, engine, ai, player, guardsCh };
}

const log = (...a) => console.log(...a);

{
  const { ai } = await makeWorld();
  const grid = ai.navGrid;
  log('bake            ', JSON.stringify(grid.stats));
  log('roles           ', ai.guards.map((g) => g.role).join(','));
  log('LOS past the wall end (x=30)  :', grid.losClear(30, 1.6, 20, 30, 1.3, -20), '(want true)');
  log('LOS through the wall  (x=0)   :', grid.losClear(0, 1.6, 20, 0, 1.3, -20), '(want false)');
  log('LOS over the wall from a tower:', grid.losClear(0, 9.0, 20, 0, 1.3, -20), '(want true)');
  log('walkable on the wall / beside :', grid.walkable(0, 0), '/', grid.walkable(0, 4));
  const p = grid.findPath(new THREE.Vector3(0, 0, 12), new THREE.Vector3(0, 0, -12));
  log('path round the wall           :', p ? `${p.length} corners  ` + p.map((v) => `${v.x.toFixed(0)},${v.z.toFixed(0)}`).join(' -> ') : 'none');
  let t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) grid.findPath(new THREE.Vector3(0, 0, 12), new THREE.Vector3(0, 0, -12));
  log('A* cost                       :', (Number(process.hrtime.bigint() - t) / 1e6 / 200).toFixed(3), 'ms');
  t = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) grid.losClear(0, 1.6, 20, 0, 1.3, -20);
  log('LOS cost                      :', (Number(process.hrtime.bigint() - t) / 1e3 / 20000).toFixed(2), 'us');
}

log('\ntime for ONE guard to reach positive ID, everything else held still:');
async function detect({ dist, stance = 'stand', off = 0, speed = 0, max = 25, wall = false }) {
  const { engine, ai, player } = await makeWorld();
  ai.setLive(true);
  // Only the guard under test exists, so nobody else can escalate the squad.
  ai.guards.length = 1;
  const gd = ai.guards[0];
  gd.ch.position.set(0, 0, wall ? 12 : 30);
  gd.home.copy(gd.ch.position);
  // yaw 0 => forward is -z, so the wall at z = 0 sits between the two of them.
  gd.ch.yaw = gd.lookYaw = gd.homeYaw = wall ? 0 : Math.PI;
  const a = gd.lookYaw + off;
  const px = gd.ch.position.x - Math.sin(a) * dist;
  const pz = gd.ch.position.z - Math.cos(a) * dist;
  let f = 0;
  const lim = max * 60;
  for (; f < lim; f++) {
    player.position.set(px, 0, pz);
    player.anim.stance = stance;
    // A moving target: displace him across the guard's view so `speed` is real
    // without letting him walk out of the test geometry.
    if (speed) player.position.x += Math.sin(engine.elapsed * 6) * speed / 6;
    gd.lookTimer = 1e9; gd.lookGoal = gd.lookYaw;
    engine.step(1 / 60);
    if (gd.awareness >= 1) break;
  }
  return f >= lim ? `>${max}s` : `${(f / 60).toFixed(2)}s`;
}
const rows = [
  ['  8 m, centre, standing, still  ', await detect({ dist: 8 })],
  [' 15 m, centre, standing, still  ', await detect({ dist: 15 })],
  [' 25 m, centre, standing, still  ', await detect({ dist: 25 })],
  [' 40 m, centre, standing, still  ', await detect({ dist: 40 })],
  [' 55 m, centre, standing, still  ', await detect({ dist: 55 })],
  [' 25 m, centre, standing, MOVING ', await detect({ dist: 25, speed: 1.5 })],
  [' 25 m, centre, CROUCHED, still  ', await detect({ dist: 25, stance: 'crouch' })],
  [' 25 m, centre, PRONE, still     ', await detect({ dist: 25, stance: 'prone' })],
  ['  8 m, centre, PRONE, still     ', await detect({ dist: 8, stance: 'prone' })],
  [' 40 m, centre, PRONE, still     ', await detect({ dist: 40, stance: 'prone' })],
  [' 25 m, 30 deg off axis          ', await detect({ dist: 25, off: 0.52 })],
  [' 25 m, 50 deg off axis          ', await detect({ dist: 25, off: 0.87 })],
  [' 25 m, 90 deg off axis          ', await detect({ dist: 25, off: 1.57, max: 8 })],
  [' 25 m, directly behind          ', await detect({ dist: 25, off: Math.PI, max: 8 })],
  [' 24 m, through the wall         ', await detect({ dist: 24, wall: true, max: 8 })],
];
for (const [k, v] of rows) log('  ' + k + '  ' + v);

log('\nalert ladder — seen for 6 s at 18 m, then vanishes:');
{
  const { engine, ai, player } = await makeWorld();
  ai.setLive(true);
  const gd = ai.guards[0];
  gd.ch.yaw = gd.lookYaw = gd.homeYaw = Math.PI; // faces +z
  const px = gd.ch.position.x;
  const pz = gd.ch.position.z + 18;
  const seen = [];
  ai.onAlertChange((e) => seen.push(`  ${engine.elapsed.toFixed(1).padStart(6)}s  ${e.from} -> ${e.to}  (${e.reason})`));
  const marks = [];
  for (let i = 0; i < 60 * 150; i++) {
    if (i < 60 * 6) player.position.set(px, 0, pz);
    else if (i === 60 * 6) player.position.set(400, 0, 400);
    engine.step(1 / 60);
    if (i % (60 * 15) === 0) {
      const c = (s) => ai.guards.filter((x) => x.state === s).length;
      marks.push(`  ${(engine.elapsed).toFixed(0).padStart(4)}s  ${ai.alertLevel.padEnd(8)} combat=${c('combat')} search=${c('search')} investigate=${c('investigate')} hold=${c('hold')} patrol=${c('patrol')} return=${c('return')} scan=${c('scan')}`);
    }
  }
  for (const s of seen) log(s);
  log('  ---');
  for (const s of marks) log(s);
}

log('\nnoise only (no line of sight anywhere):');
{
  const { engine, ai } = await makeWorld();
  ai.setLive(true);
  ai.hearNoise(new THREE.Vector3(0, 0, 26), 30, 'noise', 0.4);
  const seen = [];
  ai.onAlertChange((e) => seen.push(`  ${engine.elapsed.toFixed(1)}s ${e.from} -> ${e.to} (${e.reason})`));
  for (let i = 0; i < 60 * 45; i++) {
    engine.step(1 / 60);
    if (i === 30) log(`  after 0.5 s: ${ai.alertLevel}, investigating=${ai.guards.filter((x) => x.state === 'investigate').length}, max awareness=${Math.max(...ai.guards.map((x) => x.awareness)).toFixed(2)}`);
  }
  for (const s of seen) log(s);
  log(`  after 45 s: ${ai.alertLevel}`);
}

log('\nbody discovery:');
{
  const { engine, ai } = await makeWorld();
  ai.setLive(true);
  ai.tranquillise(ai.guards[1]);
  const finder = ai.guards[2];
  finder.ch.position.set(ai.guards[1].ch.position.x + 4, 0, ai.guards[1].ch.position.z);
  finder.homeYaw = finder.lookYaw = Math.atan2(
    -(ai.guards[1].ch.position.x - finder.ch.position.x),
    -(ai.guards[1].ch.position.z - finder.ch.position.z),
  );
  let f = 0;
  for (; f < 600; f++) { engine.step(1 / 60); if (ai.alertLevel === 'ALERT') break; }
  log(`  ${ai.alertLevel} after ${(f / 60).toFixed(2)}s; the downed man is ${ai.guards[1].ch.anim.stance}, state ${ai.guards[1].state}`);
  const b = await makeWorld();
  b.ai.setLive(true);
  b.ai.tranquillise(b.ai.guards[1]);
  b.ai.guards[2].ch.position.set(200, 0, 200);
  b.ai.guards[0].ch.position.set(210, 0, 200);
  b.ai.guards[3].ch.position.set(220, 0, 200);
  for (let i = 0; i < 600; i++) b.engine.step(1 / 60);
  log(`  body alone in a corner: ${b.ai.alertLevel} (want CALM)`);
}

log('\ncost:');
{
  const { engine, ai, player } = await makeWorld();
  ai.setLive(true);
  player.position.set(0, 0, 12);
  const base = ai.guards.slice();
  for (let i = base.length; i < 48; i++) {
    const src = base[i % base.length];
    const c = Object.create(Object.getPrototypeOf(src));
    Object.assign(c, src);
    c.id = 5000 + i;
    c.ch = stubChar('clone' + i, (i % 8) * 5 - 20, 28 + Math.floor(i / 8) * 4, Math.PI);
    c.home = c.ch.position.clone();
    c.vis = { visible: false, rate: 0, dist: Infinity };
    c.bodySeen = new Set();
    c.path = null; c.goal = null; c.lastSeenAt = new THREE.Vector3();
    ai.guards.push(c);
  }
  ai.stats.msPeak = 0;
  const grid = ai.navGrid;
  const raw = grid.findPath.bind(grid);
  let pathPeak = 0; let pathN = 0; let pathSum = 0;
  grid.findPath = (a, b, c) => {
    const s = process.hrtime.bigint();
    const r = raw(a, b, c);
    const d = Number(process.hrtime.bigint() - s) / 1e6;
    pathPeak = Math.max(pathPeak, d); pathSum += d; pathN++;
    return r;
  };
  let t = process.hrtime.bigint();
  for (let i = 0; i < 1800; i++) engine.step(1 / 60);
  log(`  48 guards, squad in contact  : ${(Number(process.hrtime.bigint() - t) / 1e6 / 1800).toFixed(3)} ms/frame  (module EMA ${ai.stats.ms} ms, peak ${ai.stats.msPeak} ms)`);
  log(`     of which A*: ${pathN} searches, mean ${(pathSum / Math.max(1, pathN)).toFixed(3)} ms, worst ${pathPeak.toFixed(3)} ms`);
  grid.findPath = raw;
  ai.guards.length = base.length;
  ai.stats.msPeak = 0;
  t = process.hrtime.bigint();
  for (let i = 0; i < 1800; i++) engine.step(1 / 60);
  log(`   4 guards, squad in contact  : ${(Number(process.hrtime.bigint() - t) / 1e6 / 1800).toFixed(3)} ms/frame  (module EMA ${ai.stats.ms} ms, peak ${ai.stats.msPeak} ms)`);
  ai.setLive(false);
  ai.stats.msPeak = 0;
  t = process.hrtime.bigint();
  for (let i = 0; i < 1800; i++) engine.step(1 / 60);
  log(`   4 guards, backdrop (godmode): ${(Number(process.hrtime.bigint() - t) / 1e6 / 1800).toFixed(3)} ms/frame  (module EMA ${ai.stats.ms} ms)`);
}

log('\nbackdrop (menu / godmode / the shot harness):');
{
  const { engine, ai } = await makeWorld();
  const before = ai.guards.map((x) => [x.ch.position.x, x.ch.position.z]);
  for (let i = 0; i < 900; i++) engine.step(1 / 60);
  const drift = Math.max(...ai.guards.map((x, i) => Math.hypot(x.ch.position.x - before[i][0], x.ch.position.z - before[i][1])));
  log(`  translation over 15 s: ${drift.toFixed(6)} m (want 0)`);
  engine.elapsed = 12.5; engine.step(0);
  const a = ai.guards.map((x) => x.ch.yaw.toFixed(9) + '/' + x.lookYaw.toFixed(9));
  for (let i = 0; i < 733; i++) engine.step(1 / 60);
  engine.elapsed = 12.5; engine.step(0);
  const b = ai.guards.map((x) => x.ch.yaw.toFixed(9) + '/' + x.lookYaw.toFixed(9));
  log(`  same elapsed => same pose after 733 unrelated frames: ${a.every((v, i) => v === b[i])}`);
}
