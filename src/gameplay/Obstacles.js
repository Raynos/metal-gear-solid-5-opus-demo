import * as THREE from 'three';

/**
 * ObstacleField — a top-down height bake of everything solid, used for player
 * collision, camera collision and cover detection.
 *
 * WHY A BAKE. The outpost publishes `bounds`, `coverPoints` and a ground
 * height, but its *structures* are merged into a handful of huge meshes
 * (`op-arch-concrete` is every wall, plinth and lintel on the site in one
 * geometry) plus instanced props. There is no collider list, and an AABB per
 * mesh is either one box round the whole compound or nothing. Raycasting the
 * merged meshes without a BVH is hundreds of thousands of triangle tests per
 * query, which is not a per-frame budget.
 *
 * So the GPU draws it once. An orthographic camera above the compound renders
 * world-space Y into a byte target with the depth test picking the highest
 * surface per texel. One readback later, collision is an array lookup — and it
 * keeps working whatever the outpost author builds next round, because nothing
 * here knows what a wall or a container is.
 *
 * THE CEILING CLIP is what makes this a floor plan rather than a roof plan. The
 * camera's near plane sits at `padLevel + CEILING`, so camo nets at 3.9 m,
 * roofs at 3.2 m and the tops of the towers are clipped away entirely and the
 * player walks under them; a wall's lower 2.35 m still bakes and still blocks.
 * Door and gate openings fall out for free — the lintel is above the clip, so
 * the opening reads as passable ground.
 *
 * Byte precision, not float: 8 bits over the 14.5 m band the camera can see is
 * 57 mm, which is an order of magnitude finer than the 450 mm step-up test that
 * consumes it, and a UNSIGNED_BYTE readback is supported everywhere a float one
 * is merely likely to be.
 */

const CEILING = 2.35;     // metres above the pad that the bake can see
const BELOW = 12.0;       // how far under the pad the bake reaches
const EMPTY = -1e9;

/** Unit ring offsets, precomputed: the samplers below run every frame. */
function ring(n) {
  const r = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    r[i * 2] = Math.cos((i / n) * Math.PI * 2);
    r[i * 2 + 1] = Math.sin((i / n) * Math.PI * 2);
  }
  return r;
}
const RING8 = ring(8);
const RING12 = ring(12);

const VERT = /* glsl */`
  varying float vWorldY;
  void main() {
    #include <begin_vertex>
    #include <project_vertex>
    #ifdef USE_INSTANCING
      vWorldY = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).y;
    #else
      vWorldY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;
    #endif
  }
`;

const FRAG = /* glsl */`
  uniform float uY0;
  uniform float uRange;
  varying float vWorldY;
  void main() {
    // 0 is reserved for "nothing here" — it is what the target clears to.
    float h = clamp( ( vWorldY - uY0 ) / uRange, 0.004, 1.0 );
    gl_FragColor = vec4( h, h, h, 1.0 );
  }
`;

export class ObstacleField {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Object3D[]} roots groups whose meshes are solid
   */
  constructor(renderer, roots, { center, extent, res = 1024, padLevel = 0 }) {
    this.x0 = center.x - extent / 2;
    this.z0 = center.z - extent / 2;
    this.extent = extent;
    this.res = res;
    this.inv = res / extent;
    this.y0 = padLevel - BELOW;
    this.range = BELOW + CEILING + 0.2;
    this.data = new Uint8Array(res * res);
    this.ok = false;
    try {
      this._bake(renderer, roots, center, padLevel);
      // A bake that hit nothing means the render silently failed (wrong target
      // format, culled scene). Better to run with terrain-only collision than
      // to let the player walk through the compound believing it is solid.
      let filled = 0;
      for (let i = 0; i < this.data.length; i += 97) if (this.data[i]) filled++;
      this.ok = filled > this.data.length / 97 / 20;
      if (!this.ok) console.warn('obstacle bake produced an empty field');
    } catch (err) {
      console.error('obstacle bake failed:', err);
    }
  }

  _bake(renderer, roots, center, padLevel) {
    const res = this.res;
    const rt = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    const half = this.extent / 2;
    const top = padLevel + CEILING;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, BELOW + CEILING + 60);
    cam.position.set(center.x, top, center.z);
    // Straight down is degenerate for lookAt unless `up` leaves the view axis.
    cam.up.set(0, 0, -1);
    cam.lookAt(center.x, top - 1, center.z);
    cam.updateMatrixWorld(true);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      uniforms: { uY0: { value: this.y0 }, uRange: { value: this.range } },
    });

    // A private scene, so nothing in the live graph has its layers or its
    // visibility rewritten. The meshes are borrowed by reference and put back
    // immediately; their world matrices are already current and the temp parent
    // is the identity, so the transform survives the round trip untouched.
    const bakeScene = new THREE.Scene();
    bakeScene.overrideMaterial = mat;
    const borrowed = [];
    for (const root of roots) {
      if (!root) continue;
      root.traverse((o) => {
        if (o.isMesh && o.visible && !o.userData.noCollide) {
          borrowed.push([o, o.parent, o.matrixAutoUpdate, o.matrix.clone()]);
        }
      });
    }
    for (const [o] of borrowed) {
      o.matrixAutoUpdate = false;
      o.matrix.copy(o.matrixWorld);
      bakeScene.add(o);
    }

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, cam);
    const px = new Uint8Array(res * res * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, res, res, px);
    renderer.setRenderTarget(prevTarget);

    // Put the local matrix back verbatim rather than recomputing it. A mesh
    // that had matrixAutoUpdate off is one whose matrix was written by hand,
    // and updateMatrix() would throw that away.
    for (const [o, parent, auto, matrix] of borrowed) {
      parent?.add(o);
      o.matrix.copy(matrix);
      o.matrixAutoUpdate = auto;
      o.matrixWorldNeedsUpdate = true;
    }
    bakeScene.overrideMaterial = null;
    mat.dispose();
    rt.dispose();

    // readRenderTargetPixels returns rows bottom-up and the ortho camera's up
    // is -Z, so source row 0 is the +Z edge of the region. Flipping it here
    // makes the sampler a plain (x, z) -> index with no sign games in the hot
    // path.
    const d = this.data;
    for (let row = 0; row < res; row++) {
      const src = (res - 1 - row) * res * 4;
      const dst = row * res;
      for (let i = 0; i < res; i++) d[dst + i] = px[src + i * 4];
    }
  }

  /** Highest solid surface at (x, z), or -1e9 where nothing was baked. */
  heightAt(x, z) {
    const u = (x - this.x0) * this.inv;
    const v = (z - this.z0) * this.inv;
    if (u < 0 || v < 0 || u >= this.res || v >= this.res) return EMPTY;
    const b = this.data[(v | 0) * this.res + (u | 0)];
    return b === 0 ? EMPTY : this.y0 + (b / 255) * this.range;
  }

  /**
   * Max over a ring of radius r plus the centre. At 0.19 m per texel a 200 mm
   * wall panel is one texel wide, so a point sample walks straight through it
   * between texel centres; testing the body's own footprint is both the correct
   * test for a capsule and what closes that gap.
   */
  maxIn(x, z, r) {
    let m = this.heightAt(x, z);
    for (let i = 0; i < 16; i += 2) {
      const h = this.heightAt(x + RING8[i] * r, z + RING8[i + 1] * r);
      if (h > m) m = h;
    }
    return m;
  }

  /**
   * Outward normal of whatever is blocking near (x, z) above height `y`, or
   * null. Used to snap the player flat against cover and to pick a peek side.
   * More than two thirds of the ring blocked means the query point is inside
   * geometry rather than beside it, and there is no meaningful normal.
   */
  wallNormal(x, z, y, r, out = new THREE.Vector2()) {
    let bx = 0;
    let bz = 0;
    let hits = 0;
    // Three radii per direction, not one. A perimeter panel is 200 mm thick, so
    // a single ring at 0.8 m either lands inside it or steps clean over it
    // depending on how far off the wall the player happened to stop — which
    // made "press to cover" a coin flip.
    for (let i = 0; i < 24; i += 2) {
      const dx = RING12[i];
      const dz = RING12[i + 1];
      let hit = false;
      for (const s of [0.62, 0.85, 1.1]) {
        if (this.heightAt(x + dx * r * s, z + dz * r * s) > y) { hit = true; break; }
      }
      if (hit) {
        bx -= dx;
        bz -= dz;
        hits++;
      }
    }
    if (!hits || hits > 8) return null;
    const len = Math.hypot(bx, bz);
    if (len < 1e-4) return null;
    return out.set(bx / len, bz / len);
  }

  /**
   * March a segment and return the fraction of it that is clear, 0..1. Used for
   * camera pull-in and for the tranquilliser dart's line of flight.
   */
  clearFraction(ax, ay, az, bx, by, bz, steps = 8, pad = 0.12) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      if (this.heightAt(x, z) > y - pad) return Math.max(0, (i - 1) / steps);
    }
    return 1;
  }
}

export { CEILING as OBSTACLE_CEILING, EMPTY as OBSTACLE_EMPTY };
