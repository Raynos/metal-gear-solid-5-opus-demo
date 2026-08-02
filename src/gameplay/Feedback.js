import * as THREE from 'three';

/**
 * Feedback — what firing a weapon looks like.
 *
 * THE PROBLEM THIS EXISTS TO FIX. Measured, driving the real page with trusted
 * input: pulling the trigger moved `ammo` from 20 to 16 and changed nothing
 * else. `playAction('fire')` was never called, so the authored recoil clip in
 * src/characters/actions.js — a decaying oscillator through the weapon, the
 * clavicle, the chest and the head — never ran. No light, no flash, no impact,
 * no case, and (see src/audio) no sound. A weapon that only decrements a
 * counter is a spreadsheet.
 *
 * WHAT IS HERE, in the order a player feels it:
 *
 *   1. muzzle flash   a billboard plus a REAL PointLight, for ~2 frames. The
 *                     light is what makes it read: a flash that does not touch
 *                     the wall beside you is a sticker.
 *   2. recoil         driven in Stealth.fire(), not here — it is the animator's.
 *   3. impact         where the round lands. Sand takes a dust puff and leaves
 *                     a mark; steel and concrete throw sparks. The trace now
 *                     reports which, so the two are not the same effect tinted.
 *   4. shell          a case out of the ejection port, bouncing once.
 *   5. report         src/audio, wired through the event bus in index.js.
 *
 * COST. Four InstancedMeshes and one Sprite, all `visible = false` while their
 * pools are empty, so an idle frame pays nothing but a boolean. Nothing is
 * allocated per shot: every pool is filled at install and recycled by age. The
 * PointLight is the only real expense and it is `visible` for the two frames of
 * a flash — the outpost's own lamps use exactly this trick to keep daylight
 * frames off the multi-light shader path.
 *
 * MODE. `attach()` and `detach()` are called from play-mode enter/exit. Nothing
 * of this is in the scene in godmode, so no canonical screenshot can see it.
 */

const DUST_MAX = 56;
const SPARK_MAX = 72;
const DECAL_MAX = 28;
const SHELL_MAX = 10;

/** A soft radial blob, the base of every particle here. */
function radialTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) grd.addColorStop(t, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The flash itself: a hot core with four spikes. Drawn rather than generated
 * radially because the cross is the shape the eye reads as "muzzle flash" —
 * a plain disc reads as a lamp.
 */
function flashTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const h = size / 2;
  g.globalCompositeOperation = 'lighter';
  const core = g.createRadialGradient(h, h, 0, h, h, h * 0.34);
  core.addColorStop(0, 'rgba(255,255,250,1)');
  core.addColorStop(0.45, 'rgba(255,226,150,0.75)');
  core.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, size, size);
  // Four spikes, at four DIFFERENT lengths. Equal ones read as an anamorphic
  // lens star — a camera artefact — rather than as burning gas leaving a
  // muzzle brake, which is asymmetric because the brake's ports are.
  const spikes = [1.0, 0.66, 0.86, 0.58];
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate(h, h);
    g.rotate((i / 4) * Math.PI * 2 + Math.PI / 4);
    const len = h * spikes[i];
    const spike = g.createLinearGradient(0, 0, len, 0);
    spike.addColorStop(0, 'rgba(255,240,200,0.9)');
    spike.addColorStop(0.35, 'rgba(255,190,90,0.28)');
    spike.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = spike;
    g.beginPath();
    g.moveTo(0, -size * 0.045);
    g.lineTo(len, 0);
    g.lineTo(0, size * 0.045);
    g.closePath();
    g.fill();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Per-instance opacity. `InstancedMesh.setColorAt` gives three channels and no
 * fourth, and a dust puff has to fade its ALPHA — fading its colour toward
 * black under normal blending turns it into a shadow, which is exactly the
 * wrong read. One float attribute, injected after `<color_fragment>` so it
 * multiplies whatever the map and the instance colour produced.
 */
function fadeable(material, count) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  material.onBeforeCompile = (s) => {
    s.vertexShader = `attribute float aFade;\nvarying float vFade;\n${s.vertexShader}`
      .replace('void main() {', 'void main() {\n\tvFade = aFade;');
    s.fragmentShader = `varying float vFade;\n${s.fragmentShader}`
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vFade;');
  };
  material.customProgramCacheKey = () => 'gp-fade';
  return attr;
}

/** A recycling pool over one InstancedMesh. Never allocates after install. */
class Pool {
  constructor(mesh, attr, max) {
    this.mesh = mesh;
    this.attr = attr;
    this.max = max;
    this.live = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
  }

  spawn(p) {
    if (this.live.length >= this.max) this.live.shift();
    this.live.push(p);
    return p;
  }

  clear() {
    this.live.length = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}

export class Feedback {
  constructor({ world, ground }) {
    this.world = world;
    this.scene = world.scene;
    this.ground = ground;
    this.attached = false;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._col = new THREE.Color();
    this._rng = (() => {
      let s = 0x9e3779b9;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();

    // --- muzzle flash -------------------------------------------------------
    this.flashTex = flashTexture();
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.flashTex,
      color: 0xffd8a0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // NO DEPTH TEST, and this was measured before it was decided. The
      // over-the-shoulder camera sits 2.36 m from the player and the muzzle
      // 2.12 m, so the shooter's own forearm is 20 cm in front of the flash and
      // depth-tested it vanished completely: the crop of the flash frame was a
      // sleeve. Every shipped game draws a muzzle flash without depth for this
      // reason — it is a very small, very bright emitter, and a real one blooms
      // around a thin occluder rather than being hidden by it. It is on screen
      // for two frames at 0.3 m across, so the cost of being wrong when the
      // barrel is genuinely inside a wall is two frames of a small bright dot.
      depthTest: false,
      transparent: true,
      fog: false,
      toneMapped: true,
    }));
    this.flash.visible = false;
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 4000;
    /**
     * THE FLASH IS COUNTED IN FRAMES, NOT SECONDS, and that is the whole of it.
     *
     * It was written as a 42 ms life, which is right for a real muzzle flash
     * and wrong for this renderer: measured driving the page, the frame time is
     * 26-45 ms, so the flash was created and expired inside a single update and
     * the probe recorded zero frames of it and a peak light intensity of zero.
     * A flash nobody can be shown is not a flash. Two frames is the minimum
     * that survives a slow frame, and it is also what the real thing looks like
     * on a 30 Hz capture.
     */
    this.flashN = 0;
    this.flashI = 0;
    this.flashScale = 1;

    // The light. Short range on purpose: a muzzle flash is a very small, very
    // bright source, so the falloff has to be violent or it reads as a flare.
    this.light = new THREE.PointLight(0xffc98a, 0, 13, 2.0);
    this.light.castShadow = false;
    this.light.visible = false;
    this.lightPeak = 0;

    // --- particles ----------------------------------------------------------
    const quad = new THREE.PlaneGeometry(1, 1);
    this.puffTex = radialTexture(64, [
      [0, 'rgba(255,255,255,0.95)'],
      [0.45, 'rgba(255,255,255,0.45)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    this.sparkTex = radialTexture(32, [
      [0, 'rgba(255,255,255,1)'],
      [0.3, 'rgba(255,220,150,0.7)'],
      [1, 'rgba(255,140,40,0)'],
    ]);

    const dustMat = new THREE.MeshBasicMaterial({
      map: this.puffTex, transparent: true, depthWrite: false, fog: true, toneMapped: true,
    });
    const dustGeo = quad.clone();
    this.dust = new THREE.InstancedMesh(dustGeo, dustMat, DUST_MAX);
    const dustFade = fadeable(dustMat, DUST_MAX);
    dustGeo.setAttribute('aFade', dustFade);
    this.dust.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dustPool = new Pool(this.dust, dustFade, DUST_MAX);

    const sparkMat = new THREE.MeshBasicMaterial({
      map: this.sparkTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      fog: true, toneMapped: true,
    });
    const sparkGeo = quad.clone();
    this.spark = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARK_MAX);
    const sparkFade = fadeable(sparkMat, SPARK_MAX);
    sparkGeo.setAttribute('aFade', sparkFade);
    this.spark.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkPool = new Pool(this.spark, sparkFade, SPARK_MAX);

    // --- ground marks -------------------------------------------------------
    // The dart itself leaves almost nothing; what the eye picks up is the
    // disturbed, darker sand around the entry. Alpha-blended and DARK, laid on
    // the ground plane, decaying over seven seconds.
    this.decalTex = radialTexture(64, [
      [0, 'rgba(255,255,255,0.85)'],
      [0.35, 'rgba(255,255,255,0.5)'],
      [0.75, 'rgba(255,255,255,0.12)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    const decalMat = new THREE.MeshBasicMaterial({
      map: this.decalTex, transparent: true, depthWrite: false, fog: true, toneMapped: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const decalGeo = quad.clone();
    this.decal = new THREE.InstancedMesh(decalGeo, decalMat, DECAL_MAX);
    const decalFade = fadeable(decalMat, DECAL_MAX);
    decalGeo.setAttribute('aFade', decalFade);
    this.decal.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decalPool = new Pool(this.decal, decalFade, DECAL_MAX);

    // --- brass --------------------------------------------------------------
    // A real lit object rather than a billboard: it is the one thing in this
    // file the player looks straight at, half a metre from the camera.
    const shellGeo = new THREE.CylinderGeometry(0.0055, 0.0048, 0.039, 6, 1);
    shellGeo.rotateZ(Math.PI / 2);
    this.shell = new THREE.InstancedMesh(
      shellGeo,
      new THREE.MeshStandardMaterial({ color: 0xb08a3c, roughness: 0.34, metalness: 0.85 }),
      SHELL_MAX,
    );
    this.shell.castShadow = false;
    this.shell.receiveShadow = false;
    this.shell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellPool = new Pool(this.shell, null, SHELL_MAX);

    this.group = new THREE.Group();
    this.group.name = 'gameplay:feedback';
    this.group.add(this.flash, this.light, this.dust, this.spark, this.decal, this.shell);
  }

  /** 0 at noon, 1 deep night — the flash has to matter more in the dark. */
  get _night() {
    const el = this.world.lighting?.preset?.sunElevation ?? 30;
    return THREE.MathUtils.clamp((7.0 - el) / 13.0, 0, 1);
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.scene.add(this.group);
    // Warm the two-light shader permutation now, while the mission briefing is
    // on screen, instead of hitching on the player's first shot: three.js keys
    // its programs on the number of visible lights, so the first frame with the
    // flash lit compiles every material in view. One frame at intensity 0.0001
    // is invisible and pays that cost here.
    this.light.visible = true;
    this.light.intensity = 0.0001;
    this._warm = 2;
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.scene.remove(this.group);
    this.flashN = 0;
    this.flashI = 0;
    this.flash.visible = false;
    this.light.visible = false;
    this.light.intensity = 0;
    this.dustPool.clear();
    this.sparkPool.clear();
    this.decalPool.clear();
    this.shellPool.clear();
  }

  dispose() {
    this.detach();
    for (const t of [this.flashTex, this.puffTex, this.sparkTex, this.decalTex]) t.dispose();
    for (const m of [this.flash, this.dust, this.spark, this.decal, this.shell]) {
      m.geometry?.dispose?.();
      m.material?.dispose?.();
    }
  }

  // ------------------------------------------------------------------ events --

  /**
   * A weapon just fired. `suppressed` is the player's tranquilliser carbine: a
   * suppressor does not remove the flash, it shrinks and cools it, so the
   * difference between the player's shot and a guard's is a factor of three in
   * size and about the same in light.
   */
  muzzle(point, dir, { suppressed = true, scale = 1 } = {}) {
    if (!this.attached || !point) return;
    const s = (suppressed ? 0.30 : 0.86) * scale;
    this.flash.position.copy(point);
    this.flash.material.rotation = this._rng() * Math.PI * 2;
    this.flashScale = s * (0.85 + this._rng() * 0.3);
    this.flash.scale.setScalar(this.flashScale);
    this.flash.material.opacity = 1;
    this.flash.visible = true;
    this.flashN = suppressed ? 2 : 3;
    this.flashI = 0;

    const night = this._night;
    this.light.position.copy(point);
    this.lightPeak = (suppressed ? 90 : 330) * (0.45 + 1.9 * night) * scale;
    this.light.intensity = this.lightPeak;
    this.light.visible = true;
    this._warm = 0;

    // Muzzle smoke: two slow, dark warm puffs pushed along the bore. Sparse on
    // purpose — a suppressed weapon does not make a cloud.
    const n = suppressed ? 2 : 3;
    for (let i = 0; i < n; i++) {
      this._puff(
        point.x + dir.x * 0.1 * i, point.y + dir.y * 0.1 * i, point.z + dir.z * 0.1 * i,
        dir.x * 1.5 + this._jit(0.5), dir.y * 1.5 + this._jit(0.4) + 0.35, dir.z * 1.5 + this._jit(0.5),
        { size: 0.10 + 0.05 * i, grow: 1.9, life: 0.42 + 0.2 * this._rng(), fade: 0.30, col: [0.62, 0.58, 0.52] },
      );
    }
  }

  /** A round landed. `surface` is 'ground' | 'structure' | 'body'. */
  impact(point, surface = 'ground', dir = null) {
    if (!this.attached || !point) return;
    const nx = dir ? -dir.x : 0;
    const ny = dir ? -dir.y : 1;
    const nz = dir ? -dir.z : 0;

    if (surface === 'structure') {
      // Steel and poured concrete: a hard, bright scatter that dies in 0.2 s,
      // plus a little grey dust so it is not pure fireworks.
      for (let i = 0; i < 9; i++) {
        this._spark(point.x, point.y, point.z,
          nx * 2.6 + this._jit(3.4), ny * 2.4 + this._jit(3.0) + 1.2, nz * 2.6 + this._jit(3.4));
      }
      for (let i = 0; i < 2; i++) {
        this._puff(point.x, point.y, point.z,
          nx * 1.2 + this._jit(0.7), ny * 1.2 + this._jit(0.5) + 0.4, nz * 1.2 + this._jit(0.7),
          { size: 0.09, grow: 2.6, life: 0.5, fade: 0.34, col: [0.66, 0.64, 0.60] });
      }
      return;
    }

    if (surface === 'body') {
      for (let i = 0; i < 2; i++) {
        this._puff(point.x, point.y, point.z,
          this._jit(0.5), 0.3 + this._jit(0.3), this._jit(0.5),
          { size: 0.07, grow: 2.2, life: 0.34, fade: 0.26, col: [0.42, 0.36, 0.31] });
      }
      return;
    }

    // Sand. A low, wide puff that keeps climbing after the impact, plus a few
    // grains thrown along the ricochet, plus a mark that stays.
    //
    // THE COLOUR IS THE WHOLE PROBLEM HERE. The first version tinted the puff
    // to the sand it came out of — (0.70, 0.60, 0.44) — which is the physically
    // obvious choice and is invisible: measured against a no-effect frame, the
    // impact region moved by a mean of 9.9/8.0/6.9 out of 255 and read as
    // nothing at all at 2x. Airborne dust is not the colour of the ground; it
    // is lit from every direction at once and is much brighter and much less
    // saturated than the surface it left. That is also exactly what it looks
    // like in the reference frames.
    for (let i = 0; i < 5; i++) {
      this._puff(point.x, point.y + 0.02, point.z,
        nx * 1.1 + this._jit(1.0), 1.35 + this._jit(0.5), nz * 1.1 + this._jit(1.0),
        { size: 0.11 + 0.05 * this._rng(), grow: 3.4, life: 0.60 + 0.25 * this._rng(), fade: 0.78, col: [0.93, 0.88, 0.78] });
    }
    for (let i = 0; i < 6; i++) {
      this._spark(point.x, point.y, point.z,
        nx * 1.4 + this._jit(1.9), 1.7 + this._jit(1.1), nz * 1.4 + this._jit(1.9), [0.80, 0.70, 0.52], 0.5);
    }
    this._mark(point.x, point.z);
  }

  // ------------------------------------------------------------------- pools --

  _jit(a) {
    return (this._rng() * 2 - 1) * a;
  }

  _puff(x, y, z, vx, vy, vz, { size, grow, life, fade, col }) {
    this.dustPool.spawn({
      x, y, z, vx, vy, vz, t: 0, life, size, grow, peak: fade,
      r: col[0], g: col[1], b: col[2], spin: this._jit(2.2), rot: this._rng() * 6.28,
    });
  }

  _spark(x, y, z, vx, vy, vz, col = [1.0, 0.72, 0.34], life = 0.26) {
    this.sparkPool.spawn({
      x, y, z, vx, vy, vz, t: 0, life: life * (0.6 + 0.8 * this._rng()),
      size: 0.012 + 0.016 * this._rng(), grow: 0.4, peak: 1,
      r: col[0], g: col[1], b: col[2], spin: 0, rot: 0,
    });
  }

  _mark(x, z) {
    const y = (this.ground?.heightAt?.(x, z) ?? 0) + 0.02;
    this.decalPool.spawn({
      x, y, z, t: 0, life: 7.5, size: 0.34 + 0.12 * this._rng(), peak: 0.55,
      rot: this._rng() * 6.28,
    });
  }

  /** A case out of the port: up, right, and spinning. */
  ejectShell(point, dir, right) {
    if (!this.attached || !point) return;
    this.shellPool.spawn({
      x: point.x - dir.x * 0.18, y: point.y - 0.02, z: point.z - dir.z * 0.18,
      vx: right.x * 2.1 + this._jit(0.5) - dir.x * 0.4,
      vy: 1.5 + this._jit(0.4),
      vz: right.z * 2.1 + this._jit(0.5) - dir.z * 0.4,
      t: 0, life: 1.9,
      rot: this._rng() * 6.28, spin: 14 + this._jit(6), axis: this._rng() * 6.28,
      grounded: false,
    });
  }

  // ------------------------------------------------------------------ per frame --

  update(dt, camera) {
    if (!this.attached) return;

    // --- flash ---------------------------------------------------------------
    if (this.flashI < this.flashN) {
      // Frame 0 is full, and every frame after it is a third of the one before.
      const k = Math.pow(0.34, this.flashI);
      this.flash.material.opacity = k;
      this.flash.scale.setScalar(this.flashScale * (1 + this.flashI * 0.4));
      this.light.intensity = this.lightPeak * k;
      this.flashI++;
      if (this.flashI >= this.flashN) {
        this.flash.visible = false;
        this.light.visible = false;
        this.light.intensity = 0;
      }
    } else if (this._warm > 0) {
      // Holding the light visible for two frames after attach compiles the
      // multi-light permutation without a visible contribution.
      if (--this._warm <= 0) {
        this.light.visible = false;
        this.light.intensity = 0;
      }
    }

    // Billboards face the camera. One quaternion for every particle in the
    // frame — they are all flat and all face the same way.
    camera.getWorldQuaternion(this._q);

    this._stepBillboards(this.dustPool, dt, true);
    this._stepBillboards(this.sparkPool, dt, false);
    this._stepDecals(dt);
    this._stepShells(dt);
  }

  _stepBillboards(pool, dt, drag) {
    const live = pool.live;
    if (!live.length) {
      if (pool.mesh.visible) {
        pool.mesh.visible = false;
        pool.mesh.count = 0;
      }
      return;
    }
    const m = this._m;
    const c = this._col;
    let n = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      p.t += dt;
      if (p.t >= p.life) continue;
      // Sand and smoke lose their momentum fast and keep rising; sparks are
      // ballistic and do not.
      if (drag) {
        const k = Math.exp(-dt * 3.4);
        p.vx *= k; p.vz *= k;
        p.vy = p.vy * k + 0.55 * dt;
      } else {
        p.vy -= 11.0 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;

      const u = p.t / p.life;
      // Fade in over the first 12% so nothing pops into existence at full
      // strength, then out on a curve that keeps the tail visible.
      const a = Math.min(1, u / 0.12) * (1 - u) * (1 - u) * p.peak;
      const s = p.size * (1 + u * p.grow);
      m.makeRotationZ(p.rot);
      m.premultiply(this._rotMat());
      m.scale(this._v.set(s, s, s));
      m.setPosition(p.x, p.y, p.z);
      pool.mesh.setMatrixAt(n, m);
      pool.mesh.setColorAt(n, c.setRGB(p.r, p.g, p.b));
      pool.attr.array[n] = a;
      if (n !== i) live[n] = p;
      n++;
    }
    live.length = n;
    pool.mesh.count = n;
    pool.mesh.visible = n > 0;
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    pool.attr.needsUpdate = true;
  }

  _rotMat() {
    return this._billboard ? this._billboard.makeRotationFromQuaternion(this._q)
      : (this._billboard = new THREE.Matrix4()).makeRotationFromQuaternion(this._q);
  }

  _stepDecals(dt) {
    const pool = this.decalPool;
    const live = pool.live;
    if (!live.length) {
      if (pool.mesh.visible) { pool.mesh.visible = false; pool.mesh.count = 0; }
      return;
    }
    const m = this._m;
    const c = this._col;
    let n = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      p.t += dt;
      if (p.t >= p.life) continue;
      const u = p.t / p.life;
      // The mark is at its darkest immediately and then the wind takes it.
      const a = Math.min(1, u / 0.05) * (1 - u * u) * p.peak;
      m.makeRotationX(-Math.PI / 2);
      m.multiply(this._decalSpin(p.rot));
      m.scale(this._v.set(p.size, p.size, p.size));
      m.setPosition(p.x, p.y, p.z);
      pool.mesh.setMatrixAt(n, m);
      // Disturbed sand is darker and slightly cooler than the surface it broke.
      pool.mesh.setColorAt(n, c.setRGB(0.20, 0.17, 0.13));
      pool.attr.array[n] = a;
      if (n !== i) live[n] = p;
      n++;
    }
    live.length = n;
    pool.mesh.count = n;
    pool.mesh.visible = n > 0;
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    pool.attr.needsUpdate = true;
  }

  _decalSpin(r) {
    (this._ds ??= new THREE.Matrix4()).makeRotationZ(r);
    return this._ds;
  }

  _stepShells(dt) {
    const pool = this.shellPool;
    const live = pool.live;
    if (!live.length) {
      if (pool.mesh.visible) { pool.mesh.visible = false; pool.mesh.count = 0; }
      return;
    }
    const m = this._m;
    let n = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      p.t += dt;
      if (p.t >= p.life) continue;
      if (!p.grounded) {
        p.vy -= 9.81 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rot += p.spin * dt;
        const gy = (this.ground?.heightAt?.(p.x, p.z) ?? 0) + 0.006;
        if (p.y <= gy) {
          // One bounce, most of the energy gone into the sand.
          p.y = gy;
          if (Math.abs(p.vy) > 0.55) {
            p.vy = -p.vy * 0.26;
            p.vx *= 0.4; p.vz *= 0.4; p.spin *= 0.35;
          } else {
            p.grounded = true;
            p.vy = 0;
          }
        }
      }
      // Fades out where it lies rather than vanishing.
      const u = p.t / p.life;
      const s = u > 0.82 ? Math.max(0, 1 - (u - 0.82) / 0.18) : 1;
      m.makeRotationY(p.axis);
      m.multiply(this._decalSpin(p.rot));
      m.scale(this._v.set(s, s, s));
      m.setPosition(p.x, p.y, p.z);
      pool.mesh.setMatrixAt(n, m);
      if (n !== i) live[n] = p;
      n++;
    }
    live.length = n;
    pool.mesh.count = n;
    pool.mesh.visible = n > 0;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  /** For probes: how much of this is alive right now. */
  stats() {
    return {
      attached: this.attached,
      flash: this.flashI < this.flashN,
      lightIntensity: +this.light.intensity.toFixed(2),
      dust: this.dustPool.live.length,
      sparks: this.sparkPool.live.length,
      decals: this.decalPool.live.length,
      shells: this.shellPool.live.length,
      draws: (this.flash.visible ? 1 : 0) + (this.dust.visible ? 1 : 0)
        + (this.spark.visible ? 1 : 0) + (this.decal.visible ? 1 : 0) + (this.shell.visible ? 1 : 0),
    };
  }
}
