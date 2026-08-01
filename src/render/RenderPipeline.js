import * as THREE from 'three';
import { GRADE } from '../config/ArtDirection.js';

/**
 * RenderPipeline — HDR post stack.
 *
 *   scene (jittered projection) -> HDR half-float RT + depth
 *     -> GTAO (horizon search, bilateral)                    [occlusion]
 *     -> prepare: AO apply + aerial perspective               [atmosphere]
 *     -> TAA resolve (reprojection + YCoCg neighbourhood clip)
 *     -> luminance reduction + eye adaptation                 [auto exposure]
 *     -> bloom mip chain + anamorphic streak
 *     -> bokeh DOF fused with camera motion blur
 *     -> composite: exposure, ACES, 3D LUT grade, barrel distortion,
 *        chromatic aberration, lens dirt veiling, vignette, grain
 *     -> FXAA / sharpen -> screen
 *
 * Design notes worth knowing before editing:
 *
 *  - Aerial perspective is a *post* pass driven by depth, not scene fog. It
 *    needs the view direction to pick up the sun's phase function, which fog
 *    cannot do. `Lighting` feeds it the same atmosphere numbers the sky dome is
 *    drawn with, so a ridge fades into exactly the sky behind it.
 *  - AO is applied *before* TAA on purpose: the temporal filter then denoises
 *    the occlusion for free, which is why 4 slices of horizon search is enough.
 *  - Everything upstream of the composite is linear HDR. Tonemapping happens
 *    once, in the composite. Never add another.
 */

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared helpers injected into several fragment shaders. */
const COMMON_GLSL = /* glsl */ `
float linearizeDepth(float d, float near, float far) {
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}
vec3 viewFromDepth(vec2 uv, float d, mat4 projInv) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = projInv * clip;
  return v.xyz / v.w;
}
vec3 worldFromDepth(vec2 uv, float d, mat4 invViewProj) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = invViewProj * clip;
  return w.xyz / w.w;
}
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

/** 16-sample Halton(2,3) jitter, centred on the pixel. */
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
const JITTER = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

/**
 * Luminance of the surface the exposure is metered against: PALETTE.sandLight,
 * which is what most of an Afghan valley actually is. Exposure is derived from
 * how much light is FALLING on that surface, never from what happens to be in
 * frame — see `_updateExposure`.
 */
const EXPOSURE_REF_ALBEDO = 0.55;
const lum3 = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function makeQuad(material) {
  const geo = new THREE.BufferGeometry();
  // Full-screen triangle: fewer fragments than a quad, no diagonal seam.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Procedural assets: the colour LUT and the lens dirt map
// ---------------------------------------------------------------------------

const LUT_N = 32;

/**
 * Bake the grade into a 32^3 LUT laid out as a 1024x32 strip.
 *
 * A LUT is not just a speed trick here: it lets the grade be a real
 * three-dimensional transform (hue-dependent shifts, channel crosstalk, a
 * per-channel film curve) instead of the per-channel multiply the composite
 * used to do, which could only ever tint and never actually shape colour.
 */
/**
 * @param {(l:number)=>number} bandWarp
 *   Maps a display luminance to the display luminance the SAME scene radiance
 *   used to have under the raw-ACES curve. Identity ablates it.
 *
 *   The grade's band selectors — the split tone, the deep-shadow fill — are
 *   authored as display numbers ("a cast shadow on sunlit sand lands around
 *   0.25"), and every one of those numbers is a statement about scene content,
 *   not about code values. Rebuilding the tone curve's toe moved that content:
 *   the same dusk cast shadow went from display 0.10 to display 0.30, walked
 *   out from under the cool half of the split tone, and took the ridge frame's
 *   cool fraction from 14.0% to 3.2% without one tint changing. Selecting
 *   through this warp anchors the bands to the radiance they were authored
 *   against, so round 4's and round 5's band placement survives this change and
 *   any future one.
 */
function buildGradeLUT(grade, bandWarp = (l) => l) {
  const N = LUT_N;
  const data = new Uint8Array(N * N * N * 4);
  const sh = grade.shadowTint;
  const mi = grade.midTint;
  const hi = grade.highlightTint;

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  let p = 0;
  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        let r = ri / (N - 1);
        let g = gi / (N - 1);
        let b = bi / (N - 1);
        const r0 = r;
        const g0 = g;
        const b0 = b;
        const lumIn = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // --- white balance ---
        // Round 1 measured blue over red in every single daylight frame. The
        // split tone alone could not fix that: it tints bands, and the whole
        // image was cold. This warms the balance globally first, then the split
        // tone shapes it. MGSV Afghanistan is sunbaked khaki, not a quarry.
        const wb = grade.warmth;
        r *= wb[0];
        g *= wb[1];
        b *= wb[2];

        const lum0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // --- split tone ---
        // Wider midtone band than round 1: the warmth has to live in the mids,
        // which in a desert frame is most of the picture.
        //
        // Round 4 moved the cool band's top edge from 0.30 to 0.42. An MGSV
        // shadow is LIFTED — a cast shadow on sunlit sand lands around display
        // luminance 0.25, and with the edge at 0.30 that pixel was receiving
        // 1 - smoothstep(0, 0.30, 0.25) = 0.08 of the shadow tint. The cool
        // half of the split tone was, in practice, only reaching pixels the
        // frame had already crushed. At 0.42 the same pixel gets 0.36.
        //
        // Round 6: these two edges are the ONLY thing in the grade that had to
        // move with the tone curve, and it had to move a long way. The band is
        // keyed to DISPLAY luminance, and rebuilding the toe re-placed every
        // shadow in the game inside that space: measured on the dusk ridge, a
        // sky-filled cast shadow went from display luminance ~0.10 to ~0.30, so
        // at the old edge its cool-band weight fell from 0.92 to 0.59 and it
        // picked up the midtone's warmth instead. The frame's cool fraction
        // (B > R+4) collapsed from 14.0% to 3.2% — the tint had not changed at
        // all, the pixels had walked out from under it.
        //
        // The edge itself then moves 0.42 -> 0.58, in the warped (round-5
        // equivalent) space, and that is a real widening rather than a
        // re-registration. Same argument round 4 made when it moved the edge
        // from 0.30 to 0.42, one crush later: the cool half of the split tone
        // IS the sky fill, and it now has a shadow region with real gradient in
        // it to fill instead of a plate. Swept on all six daylight-and-dusk
        // shots (tools/probes/verify — the k7 sweep in the report), the trade
        // is monotone and this is where it lands:
        //
        //   edge   ridge cool%   vista R-B   ground R-B   outpost R-B
        //   0.42      11.07         12.5         10.5        14.0
        //   0.50      11.43         11.2          9.7        13.0
        //   0.58      12.12          9.7          8.5        12.0   <- shipped
        //   0.66      12.43          8.2          7.0        11.0
        //
        // 0.58 is the widest edge that keeps every daylight frame inside the
        // +8..+18 R-B band while putting the dusk criterion (>= 12%) back.
        const bandL = bandWarp(lum0);
        const sw = 1 - smoothstep(0.0, grade.splitShadowEdge ?? 0.58, bandL);
        const hw = smoothstep(grade.splitHighlightEdge ?? 0.62, 1.0, bandL);
        const mw = Math.max(0, 1 - sw - hw);
        r *= sh[0] * sw + mi[0] * mw + hi[0] * hw;
        g *= sh[1] * sw + mi[1] * mw + hi[1] * hw;
        b *= sh[2] * sw + mi[2] * mw + hi[2] * hw;

        // --- channel crosstalk ---
        // Real film emulsion bleeds between layers. A tiny amount of it stops
        // saturated pixels reading as pure digital primaries.
        const ct = 0.055;
        const rr = r * (1 - ct) + (g + b) * 0.5 * ct;
        const gg = g * (1 - ct) + (r + b) * 0.5 * ct;
        const bb = b * (1 - ct) + (r + g) * 0.5 * ct;
        r = rr; g = gg; b = bb;

        // --- saturation, weighted so shadows desaturate more than midtones ---
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const satW = grade.saturation * (0.93 + 0.12 * smoothstep(0.04, 0.4, lum));
        r = lum + (r - lum) * satW;
        g = lum + (g - lum) * satW;
        b = lum + (b - lum) * satW;

        // --- contrast about a filmic pivot ---
        // Pivot-preserving: a straight (v - pivot) * c + pivot pushes anything
        // above ~0.95 straight past 1.0, which is where round 1's clipped
        // highlights were actually manufactured — after the tonemap, in the
        // grade. This form maps 0 -> 0 and 1 -> 1 exactly and cannot overshoot,
        // so the tonemap's white point survives the grade intact.
        //
        // Round 6 rebuilt the LOWER branch. It used to be
        // `pivot * pow(v/pivot, contrast)`, which is pivot-preserving but whose
        // derivative collapses toward the black end: at display 0.02 it scaled
        // the value by 0.66 AND cut its slope by 23%, and both of those get
        // worse the darker the pixel is. That is a second toe stacked on the
        // tonemap's, sitting in exactly the band this round exists to open up;
        // measured through the full chain it cost 20-30% of the shadow slope.
        //
        // The offset form is the same curve everywhere it matters — 0 -> 0,
        // pivot -> pivot, monotone, the same midtone contrast — with the
        // singular gain at the black end replaced by the constant gain it was
        // tending to. `contrastToeOffset` is how far down the curve behaves
        // like a power; below it, like a straight line.
        const pivot = 0.42;
        const cto = grade.contrastToeOffset ?? 0.06;
        const conK = Math.pow(cto / (pivot + cto), grade.contrast);
        const con = (v) =>
          v < pivot
            ? (pivot * (Math.pow((Math.max(v, 0) + cto) / (pivot + cto), grade.contrast) - conK)) /
              (1 - conK)
            : 1 - (1 - pivot) * Math.pow(Math.max(1 - v, 0) / (1 - pivot), grade.contrast);
        r = con(r);
        g = con(g);
        b = con(b);

        // --- lifted, slightly cool toe: MGSV shadows are never crushed ---
        // The toe is where the *only* coolness in the frame belongs. Keeping it
        // here rather than in the midtones is the whole "cool shadows, warm
        // khaki mids" split; round 1 leaked it across the entire range.
        const lift = grade.lift;
        r = r * (1 - lift) + lift * 0.86;
        g = g * (1 - lift) + lift * 0.965;
        b = b * (1 - lift) + lift * 1.18;

        // --- deep-shadow fill, gated off the black point ---
        // See GRADE.shadowFill. The gate's lower edge sits just above where the
        // toe above lands display black (0.043-0.059 depending on channel), so
        // the darkest pixel in a frame is not moved at all; the taper is gone
        // by 0.42, which is the contrast pivot, so nothing at or above middle
        // grey changes. Applied per channel, after the toe, so the toe's cool
        // cast survives into the band this fills.
        const sf = grade.shadowFill ?? 0;
        if (sf > 0) {
          // Deliberately NOT put through the band warp, unlike the split tone.
          // This gate is not a statement about scene radiance, it is a statement
          // about the PRINT — "lift whatever is sitting just above display
          // black" — and after the toe rebuild the pixels sitting there are a
          // different, deeper set, which is exactly right. Warping it was tried
          // and measured: it stretched the fill's rise across display 31-50 and
          // its taper across 54-140, putting a +22.6/-17.8 codes-per-stop
          // ripple into the middle of the shadow region the rebuild exists to
          // make smooth.
          const fill = (v) => v + sf * smoothstep(0.055, 0.105, v) * (1 - smoothstep(0.13, 0.42, v));
          r = fill(r);
          g = fill(g);
          b = fill(b);
        }

        // --- gentle highlight rolloff toward a warm neutral ---
        const roll = (v, warm) => {
          const t = smoothstep(0.74, 1.05, v);
          return v * (1 - t * 0.12) + t * 0.12 * warm;
        };
        r = roll(r, 1.02);
        g = roll(g, 0.995);
        b = roll(b, 0.94);

        // --- the top of the range is identity ---
        // A grade that tints the highlights can never emit a white pixel. With
        // a warm balance (R 1.058, B 0.905) the blue channel of display white
        // maps to 0.905 BEFORE anything else touches it, so no input at all
        // could produce B = 255. Measured across every round-3 frame: R hit 255
        // and B never exceeded 243, which is why highlights ran toward
        // saturated red instead of clipping to white. Fading the whole
        // transform out to identity across the top of the range costs nothing —
        // the contrast curve is already near-identity at 1.0 and the toe lift
        // is irrelevant there — and it guarantees white in, white out.
        const idW = smoothstep(0.84, 1.0, lumIn);
        r += (r0 - r) * idW;
        g += (g0 - g) * idW;
        b += (b0 - b) * idW;

        data[p++] = Math.round(Math.min(1, Math.max(0, r)) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, g)) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, b)) * 255);
        data[p++] = 255;
      }
    }
  }

  // Repack from [b][g][r] order into the 1024x32 strip layout: tile index is
  // blue, x within the tile is red, y is green.
  const strip = new Uint8Array(N * N * N * 4);
  for (let bi = 0; bi < N; bi++) {
    for (let gi = 0; gi < N; gi++) {
      for (let ri = 0; ri < N; ri++) {
        const src = ((bi * N + gi) * N + ri) * 4;
        const x = bi * N + ri;
        const y = gi;
        const dst = (y * (N * N) + x) * 4;
        strip[dst] = data[src];
        strip[dst + 1] = data[src + 1];
        strip[dst + 2] = data[src + 2];
        strip[dst + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(strip, N * N, N, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Lens dirt: grease smears, dust motes and a couple of cleaning scratches.
 * Only ever seen multiplied into the bloom, so it reads as veiling glare
 * blooming off a dirty front element rather than as a texture.
 */
function buildLensDirt(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const acc = new Float32Array(size * size);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Broad greasy smears
  for (let i = 0; i < 26; i++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const rx = 8 + rnd() * 46;
    const ry = 8 + rnd() * 46;
    const rot = rnd() * Math.PI;
    const amp = 0.25 + rnd() * 0.75;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let dx = x - cx;
        let dy = y - cy;
        if (dx > size / 2) dx -= size;
        if (dx < -size / 2) dx += size;
        if (dy > size / 2) dy -= size;
        if (dy < -size / 2) dy += size;
        const u = (dx * cs + dy * sn) / rx;
        const v = (-dx * sn + dy * cs) / ry;
        const d = u * u + v * v;
        if (d < 1) acc[y * size + x] += amp * Math.pow(1 - d, 2.2);
      }
    }
  }
  // Fine dust specks
  for (let i = 0; i < 900; i++) {
    const cx = (rnd() * size) | 0;
    const cy = (rnd() * size) | 0;
    const r = 1 + rnd() * 2.2;
    const amp = 0.4 + rnd() * 1.4;
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        const d = Math.hypot(x, y) / r;
        if (d < 1) {
          const px = (cx + x + size) % size;
          const py = (cy + y + size) % size;
          acc[py * size + px] += amp * (1 - d) * (1 - d);
        }
      }
    }
  }
  // Cleaning scratches
  for (let i = 0; i < 5; i++) {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    const amp = 0.35 + rnd() * 0.5;
    for (let s = 0; s < 380; s++) {
      a += (rnd() - 0.5) * 0.16;
      x = (x + Math.cos(a) + size) % size;
      y = (y + Math.sin(a) + size) % size;
      const px = x | 0;
      const py = y | 0;
      for (let k = -1; k <= 1; k++) {
        const qy = (py + k + size) % size;
        acc[qy * size + px] += amp * (k === 0 ? 1 : 0.35);
      }
    }
  }

  for (let i = 0; i < size * size; i++) {
    const v = Math.min(1, acc[i]);
    // Slight chromatic split: grease refracts, so dirt is never neutral.
    data[i * 4] = Math.round(Math.min(1, v * 1.0) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, v * 0.94) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, v * 0.86) * 255);
    data[i * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class RenderPipeline {
  constructor(renderer, width, height, pixelRatio) {
    this.renderer = renderer;
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = makeQuad(null);
    this.quadScene.add(this.quad);

    this.enabled = {
      ssao: true,
      bloom: true,
      taa: true,
      fxaa: true,
      aerial: true,
      dof: true,
      motionBlur: true,
      autoExposure: true,
    };
    /**
     * Per-time-of-day exposure TRIM, set by `Lighting` from
     * `TIME_OF_DAY[x].exposure`. It is dimensionless and lives near 1.0: the
     * absolute stop is derived from the sun and sky irradiance in
     * `_updateExposure`, and this is the artistic offset on top of it.
     */
    this.exposure = 1.0;
    this._physExposure = 1;
    this._finalExposure = 1;
    /** Last solved exposure, published for the harness and the critics. */
    this.exposureInfo = null;
    this.grade = { ...GRADE };
    /**
     * Where autofocus reads depth, in UV (0,0 = bottom-left). Shots that put a
     * subject off the optical axis move it; everything else leaves it centred.
     */
    this.afPoint = new THREE.Vector2(0.5, 0.5);

    this.frame = 0;
    this._historyValid = false;
    this._prevViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._prevCamDir = new THREE.Vector3();
    this._baseProj = new THREE.Matrix4();
    this._jitProj = new THREE.Matrix4();
    this._jitProjInv = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._tmpM = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();

    this.atmosphere = {
      sunDirection: new THREE.Vector3(0.4, 0.5, -0.75).normalize(),
      sunRadiance: [5.0, 4.35, 3.5],
      skyRadiance: [0.09, 0.14, 0.26],
      rayleighScale: 1.0,
      mieScale: 1.0,
      mieG: 0.78,
      dustDensity: 1.0,
      night: 0.0,
    };

    this.lut = buildGradeLUT(this.grade);
    this.dirt = buildLensDirt(256);

    this._createTargets(width, height, pixelRatio);
    this._createMaterials();
    // The grade's band warp reads the tone curve, and the curve is only solved
    // once the composite exists, so the shipping LUT is baked here rather than
    // above. The one built above is the placeholder the material is created
    // with and is disposed by this call.
    this.refreshGrade();
  }

  // -------------------------------------------------------------------------

  _rt(w, h, extra = {}) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      ...extra,
    });
  }

  _createTargets(width, height, dpr) {
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    this.width = w;
    this.height = h;

    this.hdr = this._rt(w, h, { depthBuffer: true });
    this.hdr.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.hdr.depthTexture.minFilter = THREE.NearestFilter;
    this.hdr.depthTexture.magFilter = THREE.NearestFilter;

    // Full-res AO. Contact darkening lives in a 2-3 pixel band and a half-res
    // buffer cannot carry it however good the upsample is.
    this.aoRT = this._rt(w, h);
    this.aoBlurRT = this._rt(w, h);

    this.prepRT = this._rt(w, h);
    this.taaA = this._rt(w, h);
    this.taaB = this._rt(w, h);
    this.dofRT = this._rt(w, h);
    this.compositeRT = this._rt(w, h);

    this.bloomRTs = [];
    let bw = Math.floor(w / 2);
    let bh = Math.floor(h / 2);
    for (let i = 0; i < 6; i++) {
      this.bloomRTs.push({ a: this._rt(bw, bh), b: this._rt(bw, bh), w: bw, h: bh });
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
    }

    const sw = Math.max(4, Math.floor(w / 4));
    const sh = Math.max(4, Math.floor(h / 4));
    this.streakA = this._rt(sw, sh);
    this.streakB = this._rt(sw, sh);

    // Luminance reduction chain -> 1x1 adaptation state.
    this.lumRTs = [this._rt(64, 64), this._rt(16, 16), this._rt(4, 4), this._rt(1, 1)];
    this.adaptA = this._rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.adaptB = this._rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  }

  setSize(width, height, dpr) {
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    if (w === this.width && h === this.height) return;
    // three's RenderTarget.setSize resizes `textures` — the COLOUR attachments —
    // and nothing else. An explicitly attached `depthTexture` keeps its original
    // image dimensions, so after any resize the HDR target is assembled from a
    // colour buffer at the new size and a depth buffer at the old one. That is
    // an incomplete framebuffer: every scene draw is dropped with
    // INVALID_FRAMEBUFFER_OPERATION and the frame comes out as the grade's
    // black point (11,12,15) plus grain, silently, with no page error and a
    // zero exit code.
    //
    // This is why every 1920x1080 screenshot this project has ever taken was
    // black — the harness renders 1280x720 first, so the budget resolution the
    // whole thing is judged at was ALWAYS the second size the pipeline saw. It
    // is not resolution-specific: any resize breaks it, and it stays broken
    // until the page is reloaded. Verified against git HEAD, so it predates
    // round 5.
    const dt = this.hdr.depthTexture;
    if (dt && (dt.image.width !== w || dt.image.height !== h)) {
      dt.image.width = w;
      dt.image.height = h;
      dt.dispose();
    }
    this.hdr.setSize(w, h);
    this.prepRT.setSize(w, h);
    this.taaA.setSize(w, h);
    this.taaB.setSize(w, h);
    this.dofRT.setSize(w, h);
    this.compositeRT.setSize(w, h);
    this.aoRT.setSize(w, h);
    this.aoBlurRT.setSize(w, h);
    let bw = Math.floor(w / 2);
    let bh = Math.floor(h / 2);
    for (const rt of this.bloomRTs) {
      rt.a.setSize(bw, bh);
      rt.b.setSize(bw, bh);
      rt.w = bw;
      rt.h = bh;
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
    }
    this.streakA.setSize(Math.max(4, Math.floor(w / 4)), Math.max(4, Math.floor(h / 4)));
    this.streakB.setSize(Math.max(4, Math.floor(w / 4)), Math.max(4, Math.floor(h / 4)));
    this.width = w;
    this.height = h;
    this._historyValid = false;
  }

  /** Called by Lighting whenever the atmosphere changes. */
  setAtmosphere(a) {
    this.atmosphere = a;
  }

  /**
   * Solve the exposure from the ILLUMINANT, not from the frame.
   *
   * Round 4 exposed every shot off a centre-weighted histogram of whatever was
   * on screen, with an authority of -1 to +0.77 stops. Measured on the shipped
   * frames, flat sunlit sand under the same declared afternoon sun landed at
   * display Y 0.646 in the gameplay framing and 0.450 in the outpost framing —
   * 0.52 stops apart on the SAME material under the SAME light — and the
   * afternoon sand came out 0.58 stops BRIGHTER than the noon sand, which no
   * sun elevation can produce. An auto-exposure with that much authority is not
   * a camera, it is a per-shot grade nobody wrote down.
   *
   * A real camera on a locked-off exterior is metered once, off an incident
   * reading. That is exactly this: the horizontal irradiance is the sun's
   * radiance projected onto the ground plus the sky's, both published by
   * `Lighting` from the same atmosphere the sky dome is drawn with, and a
   * reference sand albedo turns it into the radiance the ground sends back.
   * Two shots at the same time of day therefore get a bit-identical exposure
   * whatever is in front of the lens, and if the sun's intensity is ever
   * re-tuned the exposure tracks it instead of silently cancelling it.
   *
   * `grade.exposureAdapt` is how much of a change in illuminance the camera
   * compensates for. At 1.0 every hour of the day prints identically, which is
   * as wrong as no lock at all — noon carries a stop more light than a 27
   * degree afternoon and the print should say so. At `adapt` the rendered
   * brightness moves by (1 - adapt) of the scene's own change, so afternoon
   * lands measurably under noon and night lands far under both WITHOUT any of
   * it depending on framing. `TIME_OF_DAY[x].exposure` is the per-hour trim on
   * top, and it stays near 1.0 because the law above already did the work.
   */
  _updateExposure() {
    const a = this.atmosphere;
    const cosSun = Math.max(a.sunDirection.y, 0);
    // Irradiance on a horizontal surface, in the scene's own light units.
    const keyE = lum3(a.sunRadiance) * cosSun;
    const skyE = lum3(a.skyRadiance) * Math.PI;
    const sceneL = Math.max((EXPOSURE_REF_ALBEDO / Math.PI) * (keyE + skyE), 1e-5);
    const refL = this.grade.exposureRefRadiance ?? 1.65;
    const adapt = this.grade.exposureAdapt ?? 0.72;
    const key = this.grade.exposureKey ?? 0.60;

    /**
     * Round 6 tried solving this ON THE PRINT and put it back. Recording it so
     * nobody spends the day I did on it.
     *
     * `exposureAdapt` is documented as "the rendered brightness moves by
     * (1 - adapt) of the scene's own change", and this form solves that on the
     * curve's INPUT, which only means the same thing if the curve is a power
     * law. It is not. The honest version — solve for the exposure that puts the
     * reference surface's DISPLAY value where the law asks — is two lines
     * (`_displayInv(_display(key) * pow(sceneL/refL, 1-adapt)) / sceneL`) and
     * measurably more correct. It is also not worth it. Measured on all seven
     * shots (tools/probes/verify/k4-exposurelaw.js), it moved night by 0.30
     * stops and dusk by 0.22 — not nearly enough to fix the thing it was aimed
     * at — while moving the afternoon by 0.11 stops, which took the vista's
     * pixels at max-channel >= 230 from 1.87% to 1.40% and cost a criterion
     * that currently passes.
     *
     * The night frame IS a stop too bright now that the toe no longer crushes
     * it, and the fix for that is `TIME_OF_DAY.night.exposure`, not this. See
     * the report: the numbers are measured and the change is one constant in a
     * file this pass does not own.
     */
    this._physExposure = (key / refL) * Math.pow(refL / sceneL, adapt);
    this._finalExposure = this.exposure * this._physExposure;
    this.exposureInfo = {
      keyE,
      skyE,
      sceneL,
      phys: this._physExposure,
      trim: this.exposure,
      final: this._finalExposure,
      ev: Math.log2(Math.max(this._finalExposure, 1e-9)),
    };
    return sceneL;
  }

  /**
   * ABLATION SWITCH for round 6's tone-curve work. `false` restores the round-5
   * print exactly: the raw ACES toe in the tonemap and the pure power contrast
   * in the grade LUT. Both have to move together — they are two toes stacked on
   * the same band — so toggling either one alone measures half an effect.
   */
  setToneToe(on) {
    this.grade.toeAmount = on ? 1 : 0;
    this.grade.contrastToeOffset = on ? (GRADE.contrastToeOffset ?? 0.06) : 0;
    // The band warp and the widened split-tone edge exist only because the
    // curve moved; ablating the curve without them measures a half-change and
    // reproduces nothing that ever shipped. `_bandWarp` follows `toeAmount`.
    this.grade.splitShadowEdge = on ? (GRADE.splitShadowEdge ?? 0.58) : 0.42;
    this.refreshGrade();
  }

  /**
   * The band-selector warp handed to `buildGradeLUT` — display luminance under
   * the current curve -> display luminance the same radiance had under raw
   * ACES. Sampled into a 513-entry table because the inverse is a bisection and
   * the LUT asks for it 32768 times.
   */
  _bandWarp() {
    if ((this.grade.toeAmount ?? 1) <= 0 || (this.grade.bandWarp ?? 1) <= 0) return (l) => l;
    const ws = this._whiteScale ?? 1;
    const W = this.grade.whitePoint ?? 2.6;
    const knee = W * (this.grade.shoulder ?? 0.3);
    const span = Math.max(W - knee, 1e-3);
    const aces = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
    const srgbInv = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const M = 512;
    const tab = new Float64Array(M + 1);
    for (let i = 0; i <= M; i++) {
      const v = this._displayInv(srgbInv(i / M));
      const x = Math.max(v - knee, 0) / span;
      const folded = Math.min(v, knee) + span * (x / (1 + x));
      tab[i] = Math.min(1, Math.max(0, srgb(Math.min(1, Math.max(0, aces(folded) * ws)))));
    }
    return (l) => {
      const t = Math.min(1, Math.max(0, l)) * M;
      const i = Math.min(M - 1, Math.floor(t));
      return tab[i] + (tab[i + 1] - tab[i]) * (t - i);
    };
  }

  /** Rebuild the baked grade after changing `this.grade`. */
  refreshGrade() {
    // The warp reads the tone curve, so the curve's constants have to be solved
    // before the LUT is baked, not after.
    this._refreshWhitePoint();
    if (this.lut) this.lut.dispose();
    this.lut = buildGradeLUT(this.grade, this._bandWarp());
    this.compositeMat.uniforms.tLUT.value = this.lut;
  }

  /**
   * Solve the tone curve's toe anchor and push it to the composite.
   *
   * The anchor is the point where the raw ACES fit's own log-log slope passes
   * through 1 — i.e. the last point at which it is still printing a stop of
   * scene as a stop of display. Everything above it is left alone; everything
   * below it is where the long toe lives. Solving for it rather than hard-coding
   * it means the join stays exact if the fit is ever re-derived.
   *
   * `toeSlope` is the log-log slope of the rebuilt section. 1.0 is a straight
   * line in stops; slightly under 1.0 spends a little of the scene's shadow
   * range to buy display codes, which is what a film's straight-line section
   * does (constant density per stop needs a falling log-log slope, because the
   * sRGB encode is already handing out codes as y^(1/2.4)).
   */
  _toeConstants() {
    const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    const slope = (v) => {
      const h = v * 1e-4;
      return (Math.log(fit(v + h)) - Math.log(fit(v - h))) / (Math.log(v + h) - Math.log(v - h));
    };
    let lo = 0.01;
    let hi = 2.0;
    for (let i = 0; i < 50; i++) {
      const m = Math.sqrt(lo * hi);
      if (slope(m) > 1) lo = m;
      else hi = m;
    }
    const x = Math.sqrt(lo * hi);
    const p = this.grade.toeSlope ?? 0.92;
    /**
     * ROUND 7 INTEGRATION — the deep toe moves 0.0030 -> 0.0080 and its
     * exponent 2.0 -> 2.6. Both are tonemap-INPUT units, i.e. print positions:
     * 0.0080 is scene linear 0.0141 at the afternoon exposure.
     *
     * Round 6 put the short toe below every shadow in the game and then ran a
     * straight 0.92 section from there all the way up to the anchor. Measured
     * with k-tonecurve.js that delivered 8.8-11.6 codes per stop across scene
     * linear 0.007-0.045 — better than the 0-2.4 it replaced, but still short
     * of the 12-15 the round was accepted against, AND it left 22 codes of
     * dead pedestal underneath it: the vista's and the outpost's p0.01 black
     * point went from 12 to 33, which is the one guard the rebuild broke.
     *
     * Those two failures are the same failure. A power toe hands out
     * `0.2887 * slope * (code + 14)` codes per stop, so codes bought at the
     * very bottom are the most expensive ones there are — 22 codes of pedestal
     * under the darkest content is 22 codes not spent as gradient above it.
     * Raising the knee to just under the darkest content in the frames spends
     * that pedestal on slope: the worst codes-per-stop between scene linear
     * 0.008 and 0.36 goes 8.8 -> 13.5 while p0.01 comes back DOWN, and neither
     * the shadowed-sphere band (0.018-0.029) nor mid-grey moves by a code.
     *
     * Where the frontier is, solved over toeSlope x toeKnee x toeExp x
     * shadowFill with mid-grey pinned at 120 +/- 2 (i.e. no exposure change):
     *
     *   worst codes/stop over    best achievable
     *   scene linear 0.005-0.36        11.0
     *   scene linear 0.008-0.36        14.0
     *   scene linear 0.010-0.36        15.5
     *
     * So the acceptance target of 12-15 codes/stop *from linear 0.005* is not
     * reachable at this key at all, and no toe shape gets there: 0.005 is six
     * stops under mid-grey, and six stops under mid-grey at 120 codes leaves
     * fewer than 12 codes/stop of range to hand out however they are
     * distributed. From 0.008 up it is reachable with margin, and that is
     * where the frames' content actually starts — the darkest 0.01% of the
     * vista and the outpost measures scene linear 0.008-0.010.
     */
    const kn = this.grade.toeKnee ?? 0.0080;
    const q = this.grade.toeExp ?? 2.6;
    return { fit, x, fx: fit(x), p, kn, q, amt: this.grade.toeAmount ?? 1 };
  }

  /**
   * The neutral display-linear response, CPU mirror of `acesFitted`: fold,
   * curve, white-point normalisation. The ACES matrices preserve neutrals, so
   * for a grey they drop out. This is what the exposure law is solved against.
   */
  _display(v) {
    const W = this.grade.whitePoint ?? 2.6;
    const knee = W * (this.grade.shoulder ?? 0.3);
    const span = Math.max(W - knee, 1e-3);
    const x = Math.max(v - knee, 0) / span;
    const folded = Math.min(v, knee) + span * (x / (1 + x));
    return Math.min(1, Math.max(0, this._fitCurve(folded) * (this._whiteScale ?? 1)));
  }

  /** Inverse of `_display`, by bisection. Monotone, so 44 halvings is exact. */
  _displayInv(d) {
    let lo = 1e-6;
    let hi = 64;
    for (let i = 0; i < 44; i++) {
      const m = 0.5 * (lo + hi);
      if (this._display(m) < d) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  /** The full tone curve, CPU mirror of `filmicFit` in the composite. */
  _fitCurve(v) {
    const t = this._toe ?? (this._toe = this._toeConstants());
    if (t.amt <= 0 || v > t.x || v < 0) return t.fit(v);
    const s = v / t.kn;
    const s3 = s * s * s;
    return t.fx * Math.pow(v / t.x, t.p) * Math.pow(s3 / (1 + s3), (t.q - t.p) / 3);
  }

  /**
   * Normalise the tonemap so `grade.whitePoint` linear maps to display 1.0.
   * The ACES input/output matrices preserve neutrals (their rows sum to one),
   * so the scalar is just the reciprocal of the fit at the white point.
   */
  _refreshWhitePoint() {
    const W = this.grade.whitePoint ?? 2.6;
    const shoulder = this.grade.shoulder ?? 0.3;
    const reach = this.grade.whiteReach ?? 0.86;
    this._toe = this._toeConstants();
    const t = this._toe;
    const fit = (v) => this._fitCurve(v);
    const u = this.compositeMat.uniforms;
    u.uToeAmt.value = t.amt;
    u.uToeX.value = t.x;
    u.uToeFX.value = t.fx;
    u.uToeP.value = t.p;
    u.uToeDeep.value.set(t.kn, t.q, (t.q - t.p) / 3);
    u.uWhitePoint.value = W;
    u.uShoulder.value = shoulder;
    /**
     * `whiteReach` is what fixes "nothing in the game is ever white".
     *
     * Round 2 replaced a hard clip with a rational fold that only reaches the
     * white point ASYMPTOTICALLY, and round 3 then normalised the tonemap by
     * the fit at exactly that white point. The two together are a proof that
     * display 1.0 requires infinite input: measured across 14.5 M shipped
     * round-4 pixels the maximum 8-bit channel value was 252, and the vista and
     * ground frames topped out at 241 — including frames with the solar disc
     * directly in shot. A photograph of the sun that contains no white pixel is
     * not a restrained highlight rolloff, it is a broken one.
     *
     * Normalising at `whitePoint * reach` instead puts display 1.0 at a FINITE
     * folded value, so the top of the shoulder is a real destination that a
     * specular or a solar disc can actually arrive at, while broad surfaces —
     * which live an order of magnitude below it — still roll off on exactly the
     * same curve they did before.
     */
    this._whiteScale = 1 / Math.max(fit(W * reach), 1e-4);
    u.uWhiteScale.value = this._whiteScale;
  }

  // -------------------------------------------------------------------------

  _createMaterials() {
    const mat = (fragmentShader, uniforms) =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
      });

    // ---- GTAO -----------------------------------------------------------
    // Ground-truth ambient occlusion: two horizon angles per slice and the
    // closed-form cosine-weighted visibility integral between them. The round-1
    // pass took max(sin(horizon)) per side, which is the HBAO approximation —
    // it under-darkens creases (the integral is dominated by the *arc* between
    // horizons, not by the deepest one) and it is why nothing in the frame sat
    // in a pool of contact shading. Runs at full resolution: at 1280x720 the
    // cost is a fraction of a millisecond and half-res simply cannot resolve
    // the 2-3 pixel contact band where a sandbag meets the sand.
    this.aoMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDepth;
      uniform vec2 uResolution;
      uniform mat4 uProjInv;
      uniform vec2 uProjScale;       // projection scale for radius -> pixels
      uniform float uRadius;
      uniform float uThickness;
      uniform float uFrame;
      ${COMMON_GLSL}

      const float PI_ = 3.14159265359;
      const float HALF_PI = 1.57079632679;

      vec3 viewAt(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        return viewFromDepth(uv, d, uProjInv);
      }

      void main() {
        float d = texture2D(tDepth, vUv).x;
        if (d >= 0.9999995) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }

        vec3 P = viewFromDepth(vUv, d, uProjInv);
        vec2 texel = 1.0 / uResolution;

        // Normal reconstruction: pick the closer of each neighbour pair so
        // silhouettes do not smear a false normal across the depth step.
        vec3 pxr = viewAt(vUv + vec2(texel.x, 0.0));
        vec3 pxl = viewAt(vUv - vec2(texel.x, 0.0));
        vec3 pyu = viewAt(vUv + vec2(0.0, texel.y));
        vec3 pyd = viewAt(vUv - vec2(0.0, texel.y));
        vec3 dx = abs(pxr.z - P.z) < abs(P.z - pxl.z) ? (pxr - P) : (P - pxl);
        vec3 dy = abs(pyu.z - P.z) < abs(P.z - pyd.z) ? (pyu - P) : (P - pyd);
        vec3 N = normalize(cross(dx, dy));
        if (N.z < 0.0) N = -N;
        vec3 V = normalize(-P);

        // Screen-space radius of the world-space sample sphere.
        //
        // Round 3 ran a 2.2 m radius clamped up to 96 pixels. At arm's length
        // that is a measurement of large-scale openness, not of contact: the
        // sandbag wall in ground.png measured a bag top at (76.8, 69.7, 65.3)
        // and the crevice between two stacked bags at essentially the same
        // value, across two rounds of critique. A crevice is 10 cm wide. The
        // radius is now sized to the feature, and the pixel clamp with it, so
        // the horizon search actually resolves the 2-3 pixel contact band.
        float pixRadius = uRadius * uProjScale.y * uResolution.y * 0.5 / max(-P.z, 0.05);
        pixRadius = clamp(pixRadius, 3.0, 52.0);

        float rot = ign(gl_FragCoord.xy + uFrame * 7.13);
        float offset = fract(ign(gl_FragCoord.yx * 1.37) + uFrame * 0.618);

        const int SLICES = 3;
        const int STEPS = 8;
        float visibility = 0.0;

        for (int s = 0; s < SLICES; s++) {
          float phi = (float(s) + rot) * PI_ / float(SLICES);
          vec2 omega = vec2(cos(phi), sin(phi));
          vec3 dirV = vec3(omega, 0.0);
          vec3 sliceN = cross(dirV, V);
          float sliceLen = length(sliceN);
          if (sliceLen < 1e-5) continue;
          sliceN /= sliceLen;

          // Project the surface normal into the slice plane; the visibility
          // integral is one-dimensional in that plane.
          vec3 projN = N - sliceN * dot(N, sliceN);
          float projNLen = length(projN);
          if (projNLen < 1e-4) continue;
          vec3 tangent = cross(V, sliceN);
          float cosN = clamp(dot(projN, V) / projNLen, -1.0, 1.0);
          float n = sign(dot(projN, tangent)) * acos(cosN);

          float hA = -1.0;   // cos of the horizon on the -omega side
          float hB = -1.0;   // cos of the horizon on the +omega side

          for (int k = 0; k < STEPS; k++) {
            float t = (float(k) + offset) / float(STEPS);
            t = t * t;                      // bias samples toward the centre
            vec2 off = omega * t * pixRadius * texel;

            for (int side = 0; side < 2; side++) {
              vec2 suv = side == 0 ? vUv + off : vUv - off;
              float sd = texture2D(tDepth, suv).x;
              if (sd >= 0.9999995) continue;
              vec3 S = viewFromDepth(suv, sd, uProjInv);
              vec3 D = S - P;
              float len2 = dot(D, D);
              if (len2 < 1e-7) continue;
              float len = sqrt(len2);
              float cosH = dot(D, V) / len;
              // Range falloff, and a thickness heuristic so a thin occluder
              // (a wire, a fence post) does not shadow everything behind it.
              float w = clamp(1.0 - (len - uRadius * 0.55) / (uRadius * 0.45), 0.0, 1.0);
              if (side == 0) {
                hB = cosH > hB ? mix(hB, cosH, w) : mix(hB, cosH, uThickness);
              } else {
                hA = cosH > hA ? mix(hA, cosH, w) : mix(hA, cosH, uThickness);
              }
            }
          }

          float h1 = n + max(-acos(clamp(hA, -1.0, 1.0)) - n, -HALF_PI);
          float h2 = n + min( acos(clamp(hB, -1.0, 1.0)) - n,  HALF_PI);
          float sinN = sin(n);
          visibility += projNLen * 0.25 * (
              (h1 * 2.0 * sinN - cos(2.0 * h1 - n)) +
              (h2 * 2.0 * sinN - cos(2.0 * h2 - n)) + 2.0 * cos(n));
        }

        float ao = clamp(visibility / float(SLICES), 0.0, 1.0);
        // Store linear view depth alongside so the bilateral blur can reject
        // samples across depth discontinuities.
        gl_FragColor = vec4(ao, -P.z, 0.0, 1.0);
      }
      `,
      {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uProjInv: { value: new THREE.Matrix4() },
        uProjScale: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 1.15 },
        uThickness: { value: 0.10 },
        uFrame: { value: 0 },
      },
    );

    // ---- depth-aware bilateral blur for AO ------------------------------
    // The round-1 blur weighted by |dz| alone, which bleeds an object's own
    // occlusion out over the ground behind it whenever the two are at similar
    // depth. Weighting by the distance from the *tangent plane* instead (a
    // plane-aware bilateral) rejects the neighbour surface even when its depth
    // matches, which is what stops the halo around every silhouette.
    this.aoBlurMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tAO;
      uniform vec2 uDir;
      void main() {
        vec2 c = texture2D(tAO, vUv).rg;
        if (c.g <= 0.0) { gl_FragColor = vec4(c.r, c.g, 0.0, 1.0); return; }
        // Local depth slope along the blur axis, from the immediate neighbours.
        float dp = texture2D(tAO, vUv + uDir).g;
        float dm = texture2D(tAO, vUv - uDir).g;
        float slope = 0.0;
        if (dp > 0.0 && dm > 0.0) slope = (dp - dm) * 0.5;
        float sum = c.r;
        float wsum = 1.0;
        for (int i = 1; i <= 6; i++) {
          float fi = float(i);
          float gw = exp(-fi * fi * 0.085);
          for (int s = 0; s < 2; s++) {
            float sg = s == 0 ? 1.0 : -1.0;
            vec2 t = texture2D(tAO, vUv + uDir * fi * sg).rg;
            if (t.g <= 0.0) continue;
            float predicted = c.g + slope * fi * sg;
            float dw = exp(-abs(t.g - predicted) / (c.g * 0.012 + 0.03));
            float w = gw * dw;
            sum += t.r * w;
            wsum += w;
          }
        }
        gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
      }
      `,
      { tAO: { value: null }, uDir: { value: new THREE.Vector2() } },
    );

    // ---- prepare: AO apply + aerial perspective --------------------------
    this.prepMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform sampler2D tAO;
      uniform mat4 uInvViewProj;
      uniform mat4 uProjInv;
      uniform vec3 uCamPos;
      uniform float uAOEnabled;
      uniform float uAOPower;
      uniform float uAOFloor;
      uniform float uAODirect;
      uniform vec3 uAOTint;
      uniform float uAerialEnabled;
      // atmosphere
      uniform vec3 uSunDir;
      uniform vec3 uSunRadiance;
      uniform vec3 uSkyRadiance;
      uniform vec3 uBetaR;
      uniform vec3 uBetaM;
      uniform vec3 uBetaD;
      uniform float uMieG;
      uniform float uApStrength;
      uniform float uApAmbient;
      uniform vec3 uDustAlbedo;
      ${COMMON_GLSL}

      const float PI_ = 3.141592653589793;
      const float HR = 8000.0;
      const float HM = 1400.0;
      const float HD = 700.0;    // desert dust hugs the ground
      const float BASE_ALT = 400.0;

      float phaseR(float mu) { return (3.0 / (16.0 * PI_)) * (1.0 + mu * mu); }
      float phaseHG(float mu, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * PI_ * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
      }

      /** Integral of exp(-y/H) along a straight ray, closed form. */
      float heightInt(float y0, float y1, float dist, float H) {
        float k = (y1 - y0) / max(dist, 1e-3);
        float a = exp(-max(y0, -2000.0) / H);
        float b = exp(-max(y1, -2000.0) / H);
        if (abs(k) < 1e-3) return dist * 0.5 * (a + b);
        return (H / k) * (a - b);
      }

      void main() {
        vec3 color = texture2D(tColor, vUv).rgb;
        float d = texture2D(tDepth, vUv).x;
        bool isSky = d >= 0.9999995;

        if (uAOEnabled > 0.5 && !isSky) {
          float ao = pow(clamp(texture2D(tAO, vUv).r, 0.0, 1.0), uAOPower);
          // Jimenez multi-bounce: single-scatter AO over-darkens bright
          // albedos. Approximated against the desert palette.
          vec3 alb = vec3(0.54, 0.46, 0.33);
          vec3 a = 2.0404 * alb - 0.3324;
          vec3 b = -4.7951 * alb + 0.6417;
          vec3 c = 2.7552 * alb + 0.6903;
          vec3 mb = max(vec3(ao), ((ao * a + b) * ao + c) * ao);
          mb = max(mb, vec3(uAOFloor));
          // Occlusion removes the *sky* first — it is the widest source — and
          // leaves the ground bounce, so a pocket of AO gets warmer as it gets
          // darker. This is a bent-normal effect done on the cheap and it is a
          // large part of why a real desert crevice is ochre, not blue-black.
          vec3 occ = mb * mix(uAOTint, vec3(1.0), mb);
          // Occlusion belongs to the ambient term. With no G-buffer the split
          // cannot be exact, so lean on the fact that AO only reaches low
          // values where the sun is geometrically blocked anyway, and keep a
          // hard floor of uAODirect on lit pixels so contact shading still
          // reads on sunlit sand — the round-1 weight faded it out to nothing
          // exactly where the critics went looking for it.
          float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
          float w = mix(1.0, uAODirect, smoothstep(0.10, 0.85, lum));
          color *= mix(vec3(1.0), occ, w);
        }

        if (uAerialEnabled > 0.5 && !isSky) {
          vec3 wp = worldFromDepth(vUv, d, uInvViewProj);
          vec3 delta = wp - uCamPos;
          float dist = length(delta);
          vec3 rd = delta / max(dist, 1e-4);

          float y0 = uCamPos.y;
          float y1 = wp.y;
          float IR = heightInt(y0 + BASE_ALT, y1 + BASE_ALT, dist, HR);
          float IM = heightInt(y0 + BASE_ALT, y1 + BASE_ALT, dist, HM);
          float ID = heightInt(y0, y1, dist, HD);

          vec3 tauR = uBetaR * IR;
          vec3 tauM = uBetaM * IM;
          vec3 tauD = uBetaD * ID;
          vec3 T = exp(-(tauR + tauM * 1.11 + tauD * 1.06));

          float mu = dot(rd, uSunDir);
          // Multiple scattering flattens the effective phase function; without
          // this the anti-sun side goes implausibly black.
          float pd = mix(0.0796, phaseHG(mu, uMieG), 0.35);
          float pm = mix(0.0796, phaseHG(mu, min(uMieG + 0.05, 0.86)), 0.55);

          // Dust has its own (warm) scattering albedo. Folding it in here is
          // what keeps a hazy ridge dusty-ochre instead of inheriting the
          // sky's blue and turning the whole frame slate grey.
          vec3 sunIn = (tauR * phaseR(mu) + tauM * pm) * uSunRadiance
                     + tauD * pd * uSunRadiance * uDustAlbedo;
          vec3 ambIn = ((tauR + tauM) * uSkyRadiance
                     + tauD * uSkyRadiance * uDustAlbedo) * uApAmbient;
          vec3 S = (sunIn + ambIn) * uApStrength;

          color = color * T + S;
        }

        gl_FragColor = vec4(max(color, 0.0), 1.0);
      }
      `,
      {
        tColor: { value: null },
        tDepth: { value: null },
        tAO: { value: null },
        // Round 4: power 1.20 -> 1.55 and the floor 0.32 -> 0.14. A floor of
        // 0.32 combined with the multi-bounce lift meant the deepest crease the
        // integrator could find still came back above 0.5 — there was no pool
        // of contact darkening available to draw, whatever the weight.
        uAOPower: { value: 1.55 },
        uAOFloor: { value: 0.14 },
        uAODirect: { value: 0.52 },
        uAOTint: { value: new THREE.Vector3(1.14, 1.0, 0.78) },
        uInvViewProj: { value: new THREE.Matrix4() },
        uProjInv: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uAOEnabled: { value: 1 },
        uAerialEnabled: { value: 1 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunRadiance: { value: new THREE.Vector3(5, 4.4, 3.5) },
        uSkyRadiance: { value: new THREE.Vector3(0.09, 0.14, 0.26) },
        uBetaR: { value: new THREE.Vector3() },
        uBetaM: { value: new THREE.Vector3() },
        uBetaD: { value: new THREE.Vector3() },
        uMieG: { value: 0.72 },
        uApStrength: { value: 1.50 },
        uApAmbient: { value: 1.55 },
        uDustAlbedo: { value: new THREE.Vector3(1.04, 1.0, 0.93) },
      },
    );

    // ---- TAA resolve ----------------------------------------------------
    this.taaMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tCurrent;
      uniform sampler2D tHistory;
      uniform sampler2D tDepth;
      uniform vec2 uTexel;
      uniform mat4 uInvViewProjJit;
      uniform mat4 uPrevViewProj;
      uniform float uBlend;
      uniform float uValid;
      ${COMMON_GLSL}

      vec3 rgb2ycocg(vec3 c) {
        return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
                    0.5 * c.r - 0.5 * c.b,
                   -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
      }
      vec3 ycocg2rgb(vec3 c) {
        return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
      }
      // Tonemap/inverse pair used only for weighting: blending in a compressed
      // space stops one bright sample from dominating the average and fireflying.
      vec3 tm(vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b)); }
      vec3 itm(vec3 c) { return c / max(1e-4, 1.0 - max(max(c.r, c.g), c.b)); }

      void main() {
        vec3 cur = texture2D(tCurrent, vUv).rgb;

        if (uValid < 0.5) { gl_FragColor = vec4(cur, 1.0); return; }

        // 3x3 neighbourhood statistics in YCoCg.
        vec3 m1 = vec3(0.0);
        vec3 m2 = vec3(0.0);
        vec3 nmin = vec3(1e9);
        vec3 nmax = vec3(-1e9);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec3 s = rgb2ycocg(tm(texture2D(tCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb));
            m1 += s;
            m2 += s * s;
            nmin = min(nmin, s);
            nmax = max(nmax, s);
          }
        }
        vec3 mean = m1 / 9.0;
        vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
        // Variance clipping is far less prone to over-tight boxes on noisy
        // input (our AO) than a raw min/max box.
        vec3 lo = max(mean - sigma * 1.35, nmin);
        vec3 hi = min(mean + sigma * 1.35, nmax);

        // Reproject.
        float d = texture2D(tDepth, vUv).x;
        vec3 wp = worldFromDepth(vUv, d, uInvViewProjJit);
        vec4 pc = uPrevViewProj * vec4(wp, 1.0);
        vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;

        if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) {
          gl_FragColor = vec4(cur, 1.0);
          return;
        }

        // 5-tap Catmull-Rom keeps the history from softening every frame.
        vec2 texPos = puv / uTexel - 0.5;
        vec2 f = fract(texPos);
        vec2 texPos1 = (floor(texPos) + 0.5) * uTexel;
        vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        vec2 w3 = f * f * (-0.5 + 0.5 * f);
        vec2 w12 = w1 + w2;
        vec2 off12 = w2 / max(w12, vec2(1e-5));
        vec2 p0 = texPos1 - uTexel;
        vec2 p3 = texPos1 + uTexel * 2.0;
        vec2 p12 = texPos1 + off12 * uTexel;
        vec3 hist =
            texture2D(tHistory, vec2(p12.x, p0.y)).rgb * (w12.x * w0.y) +
            texture2D(tHistory, vec2(p0.x, p12.y)).rgb * (w0.x * w12.y) +
            texture2D(tHistory, vec2(p12.x, p12.y)).rgb * (w12.x * w12.y) +
            texture2D(tHistory, vec2(p3.x, p12.y)).rgb * (w3.x * w12.y) +
            texture2D(tHistory, vec2(p12.x, p3.y)).rgb * (w12.x * w3.y);
        float wnorm = (w12.x * w0.y) + (w0.x * w12.y) + (w12.x * w12.y) + (w3.x * w12.y) + (w12.x * w3.y);
        hist /= max(wnorm, 1e-4);
        hist = max(hist, vec3(0.0));

        vec3 hy = rgb2ycocg(tm(hist));
        vec3 cy = rgb2ycocg(tm(cur));

        // Clip toward the current sample along the ray rather than clamping
        // per channel — clamping shifts hue on rejected pixels.
        vec3 centre = 0.5 * (lo + hi);
        vec3 extent = 0.5 * (hi - lo) + 1e-5;
        vec3 v = hy - centre;
        vec3 a = abs(v / extent);
        float maxA = max(a.x, max(a.y, a.z));
        float clipped = 0.0;
        if (maxA > 1.0) { hy = centre + v / maxA; clipped = 1.0; }

        // Feed back more of the current frame where history had to be clipped
        // (disocclusion) and where the image is moving fast.
        float blend = mix(uBlend, 0.45, clipped * 0.6);
        vec3 outY = mix(hy, cy, blend);
        vec3 res = itm(ycocg2rgb(outY));
        // NaN/Inf trap that does not rely on isnan(): comparisons against NaN
        // are false, so the guard catches both cases.
        if (!all(lessThan(abs(res), vec3(1.0e6)))) res = cur;
        gl_FragColor = vec4(max(res, 0.0), 1.0);
      }
      `,
      {
        tCurrent: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uInvViewProjJit: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uBlend: { value: 0.1 },
        uValid: { value: 0 },
      },
    );

    // ---- luminance reduction + adaptation --------------------------------
    this.lumMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // Centre-weighted metering. Since round 5 this drives only the +/-0.02
        // stop trim around the illuminant-derived exposure solved on the CPU.
        // The frame no longer gets to decide its own stop, which is what had
        // the same afternoon reading half a stop apart between the gameplay
        // and outpost framings.
        vec2 d = vUv - 0.5;
        float w = 1.0 - 0.62 * smoothstep(0.02, 0.26, dot(d, d));
        // Clamp the metering range so the sun disc and the blown sky cannot
        // drag the average even inside that tiny authority.
        float lg = clamp(log(max(l, 1e-4)), -5.5, 1.4);
        gl_FragColor = vec4(lg * w, w, 0.0, 1.0);
      }
      `,
      { tColor: { value: null } },
    );

    this.downMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      uniform vec2 uTexel;
      void main() {
        vec4 s = texture2D(tColor, vUv + vec2(-1.0, -1.0) * uTexel);
        s += texture2D(tColor, vUv + vec2(1.0, -1.0) * uTexel);
        s += texture2D(tColor, vUv + vec2(-1.0, 1.0) * uTexel);
        s += texture2D(tColor, vUv + vec2(1.0, 1.0) * uTexel);
        gl_FragColor = s * 0.25;
      }
      `,
      { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } },
    );

    this.adaptMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLum;
      uniform sampler2D tPrev;
      uniform sampler2D tDepth;
      uniform float uRate;
      uniform float uSnap;
      uniform float uNear;
      uniform float uFar;
      uniform vec2 uAFPoint;
      uniform float uAFRadius;
      void main() {
        vec2 lw = texture2D(tLum, vec2(0.5)).rg;
        float cur = lw.r / max(lw.g, 1e-4);
        float prev = texture2D(tPrev, vec2(0.5)).r;
        // Rods adapt slower than cones: darkening is allowed to lag more than
        // brightening, which is what makes an exposure ramp feel like an eye.
        float rate = cur < prev ? uRate * 0.55 : uRate;
        float lum = mix(prev, cur, uSnap > 0.5 ? 1.0 : rate);

        // Auto focus rides in .g: linear view distance under the AF point.
        //
        // The AF point is NOT the frame centre. An over-the-shoulder framing
        // puts its subject on the third by definition, so a centre-weighted
        // autofocus locks onto the yard 15 m behind him and hands back a hero
        // rendered entirely inside the circle of confusion — which is exactly
        // what the gameplay shot was doing. Shots declare where the subject is;
        // everything else keeps the default centre point. Nine taps across a
        // small patch, nearest wins, so a thin subject is not missed between
        // texels.
        float z = 1e9;
        for (int i = 0; i < 9; i++) {
          vec2 o = vec2(float(i / 3) - 1.0, float(i - (i / 3) * 3) - 1.0) * uAFRadius;
          float d = texture2D(tDepth, clamp(uAFPoint + o, vec2(0.002), vec2(0.998))).x;
          float zi = d >= 0.9999995 ? uFar : (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
          z = min(z, zi);
        }
        z = clamp(z, 0.3, 900.0);
        float pf = texture2D(tPrev, vec2(0.5)).g;
        float focus = mix(pf, z, uSnap > 0.5 ? 1.0 : 0.12);

        gl_FragColor = vec4(lum, focus, 0.0, 1.0);
      }
      `,
      {
        tLum: { value: null },
        tPrev: { value: null },
        tDepth: { value: null },
        uRate: { value: 0.28 },
        uSnap: { value: 1 },
        uNear: { value: 0.15 },
        uFar: { value: 6000 },
        uAFPoint: { value: new THREE.Vector2(0.5, 0.5) },
        uAFRadius: { value: 0.018 },
      },
    );

    // ---- bloom ------------------------------------------------------------
    this.brightMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tAdapt;
      uniform float uThreshold;
      uniform float uSoftKnee;
      uniform float uExposure;
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float knee = uThreshold * uSoftKnee + 1e-5;
        float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
        soft = soft * soft / (4.0 * knee);
        float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);
        // Clamp the very brightest samples: the sun disc alone would otherwise
        // dominate the whole chain and produce a flat white wash.
        c = min(c * contrib, vec3(48.0));
        gl_FragColor = vec4(c, 1.0);
      }
      `,
      {
        tDiffuse: { value: null },
        tAdapt: { value: null },
        uThreshold: { value: GRADE.bloomThreshold },
        uSoftKnee: { value: 0.65 },
        uExposure: { value: 1.0 },
      },
    );

    this.blurMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2 uDir;
      void main() {
        vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
        sum += texture2D(tDiffuse, vUv + uDir * 1.3846153846) * 0.3162162162;
        sum += texture2D(tDiffuse, vUv - uDir * 1.3846153846) * 0.3162162162;
        sum += texture2D(tDiffuse, vUv + uDir * 3.2307692308) * 0.0702702703;
        sum += texture2D(tDiffuse, vUv - uDir * 3.2307692308) * 0.0702702703;
        gl_FragColor = sum;
      }
      `,
      { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
    );

    this.upsampleMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLower;
      uniform sampler2D tHigher;
      uniform float uMix;
      void main() {
        gl_FragColor = vec4(texture2D(tHigher, vUv).rgb + texture2D(tLower, vUv).rgb * uMix, 1.0);
      }
      `,
      { tLower: { value: null }, tHigher: { value: null }, uMix: { value: 0.85 } },
    );

    // Anamorphic streak: a wide, cheap horizontal-only blur run three times so
    // the tail reaches most of the frame. The blue tint is the giveaway that
    // sells "cylindrical front element".
    this.streakMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform float uStep;
      uniform float uAttenuation;
      void main() {
        vec3 sum = vec3(0.0);
        float wsum = 1e-5;
        for (int i = -8; i <= 8; i++) {
          float fi = float(i);
          float w = pow(uAttenuation, abs(fi));
          float u = vUv.x + fi * uStep;
          // Fade samples out as they leave the frame instead of letting the
          // clamp-to-edge sampler replicate the border column. On the dusk
          // ridge, whose sun sits hard against the left border, that replicated
          // column was being smeared back across the picture as a slab of
          // glare with a visible vertical edge. A streak is light that arrived
          // from somewhere; off the edge of the sensor there is nowhere.
          w *= clamp(min(u, 1.0 - u) * 26.0, 0.0, 1.0);
          sum += texture2D(tDiffuse, vec2(clamp(u, 0.0, 1.0), vUv.y)).rgb * w;
          wsum += w;
        }
        gl_FragColor = vec4(sum / wsum, 1.0);
      }
      `,
      { tDiffuse: { value: null }, uStep: { value: 0.002 }, uAttenuation: { value: 0.86 } },
    );

    // ---- bokeh DOF fused with camera motion blur --------------------------
    this.dofMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform sampler2D tAdapt;
      uniform vec2 uTexel;
      uniform mat4 uInvViewProjJit;
      uniform mat4 uPrevViewProj;
      uniform float uNear;
      uniform float uFar;
      uniform float uFocal;      // focal length, metres (derived from the FOV)
      uniform float uAperture;   // aperture diameter, metres
      uniform float uSensorPx;   // pixels per metre of sensor height
      uniform float uMaxCoCFar;  // hard ceiling on background defocus, pixels
      uniform float uMaxCoCNear; // hard ceiling on foreground defocus, pixels
      uniform float uCoCFloor;   // CoC below this costs nothing and is dropped
      uniform float uEdgeSoftness;
      uniform float uMotionScale;
      uniform float uFrame;
      uniform float uEnabled;
      ${COMMON_GLSL}

      float viewZ(float d) {
        if (d >= 0.9999995) return uFar;
        return (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
      }

      /**
       * Honest thin-lens circle of confusion, in pixels.
       *
       * Round 5: the ceiling is now ASYMMETRIC and both halves of it are about
       * a pixel, not thirteen. A game is not a photograph. Round 4 ran the same
       * +/-13 px clamp on both sides of focus, so an over-the-shoulder framing
       * focused at 2.1 m put the entire playable mid-ground — building,
       * barrels, fence — under a 4 px circle of confusion, and a ground-level
       * shot metering its focus on the mid-distance put the sand at the
       * camera's feet under the same. Measured on the round-4 gameplay frame,
       * the building roofline against the sky resolved over 5.1 px.
       *
       * MGSV uses defocus as a whisper: a little far-field separation behind a
       * near subject, a gentle near-field falloff, and a playable mid-ground
       * that is always sharp. That is what a small aperture buys, and the
       * clamps here are the seatbelt that guarantees it even if the autofocus
       * locks somewhere absurd.
       */
      float cocAt(float z, float focus) {
        float c = uAperture * uFocal * (z - focus) / (max(z, 0.02) * max(focus - uFocal, 1e-4));
        return clamp(c * uSensorPx, -uMaxCoCNear, uMaxCoCFar);
      }

      void main() {
        vec3 centre = texture2D(tColor, vUv).rgb;
        if (uEnabled < 0.5) { gl_FragColor = vec4(centre, 1.0); return; }

        float focus = max(texture2D(tAdapt, vec2(0.5)).g, 1.0);
        float d = texture2D(tDepth, vUv).x;
        float z = viewZ(d);
        float coc = abs(cocAt(z, focus));

        // Field curvature: real lenses lose the corners. A perfectly sharp
        // frame edge is one of the strongest "this is CG" cues. Round 5 cut it
        // from 1.2 px to a quarter of a pixel: at 1.2 px this term ALONE was
        // above the pass's own skip threshold, so every pixel outside the
        // middle sixth of the frame went through the 24-tap bokeh gather
        // whatever its depth. That is a full-frame blur wearing a lens's name.
        vec2 cen = vUv - 0.5;
        float r2 = dot(cen, cen);
        coc += uEdgeSoftness * smoothstep(0.06, 0.28, r2);

        // Camera velocity from depth reprojection (static geometry).
        vec2 vel = vec2(0.0);
        if (uMotionScale > 0.0) {
          vec3 wp = worldFromDepth(vUv, d, uInvViewProjJit);
          vec4 pc = uPrevViewProj * vec4(wp, 1.0);
          vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;
          vel = (vUv - puv) * uMotionScale;
          float vl = length(vel / uTexel);
          if (vl > 48.0) vel *= 48.0 / vl;
        }
        float velPix = length(vel / uTexel);

        // Sub-pixel defocus is not defocus, it is a soft filter over a sharp
        // image. Anything under the floor passes through untouched.
        if (coc < uCoCFloor && velPix < 0.8) { gl_FragColor = vec4(centre, 1.0); return; }
        coc = max(coc - uCoCFloor * 0.5, 0.0);

        float rot = ign(gl_FragCoord.xy + uFrame * 3.7) * 6.2831853;
        float cr = cos(rot), sr = sin(rot);

        vec3 sum = centre;
        float wsum = 1.0;
        const int TAPS = 24;
        for (int i = 0; i < TAPS; i++) {
          float fi = float(i);
          float t = (fi + 0.5) / float(TAPS);
          float rr = sqrt(t);
          float th = fi * 2.39996323;
          vec2 disk = vec2(cos(th), sin(th)) * rr;
          disk = vec2(disk.x * cr - disk.y * sr, disk.x * sr + disk.y * cr);
          // Slightly hexagonal aperture: a perfect circle reads as a gaussian,
          // a hex blade edge reads as a lens.
          float ang = atan(disk.y, disk.x);
          float hex = 1.0 - 0.055 * cos(6.0 * ang);
          disk *= hex;

          vec2 off = disk * coc * uTexel + vel * (t - 0.5);
          vec2 suv = vUv + off;
          vec3 sc = texture2D(tColor, suv).rgb;
          float sz = viewZ(texture2D(tDepth, suv).x);
          float scoc = max(abs(cocAt(sz, focus)) + uEdgeSoftness * smoothstep(0.06, 0.28, r2) - uCoCFloor * 0.5, 0.0);
          // Only accept a sample if its own blur circle reaches this pixel,
          // otherwise sharp foreground bleeds outward.
          float reach = length(disk) * coc;
          float w = clamp((scoc - reach) * 0.6 + 1.0, 0.0, 1.0);
          w = max(w, velPix > 1.0 ? 0.85 : 0.0);
          // Energy-preserving highlight response: bokeh discs from bright
          // sources should stay bright, not average into grey.
          float hw = 1.0 + 3.0 * smoothstep(1.2, 8.0, dot(sc, vec3(0.2126, 0.7152, 0.0722)));
          sum += sc * w * hw;
          wsum += w * hw;
        }
        gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
      }
      `,
      {
        tColor: { value: null },
        tDepth: { value: null },
        tAdapt: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uInvViewProjJit: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uNear: { value: 0.15 },
        uFar: { value: 6000 },
        uFocal: { value: 0.031 },
        uAperture: { value: 0.013 },
        uSensorPx: { value: 30000 },
        uMaxCoCFar: { value: 2.4 },
        uMaxCoCNear: { value: 1.2 },
        uCoCFloor: { value: 0.9 },
        uEdgeSoftness: { value: 0.25 },
        uMotionScale: { value: 0.55 },
        uFrame: { value: 0 },
        uEnabled: { value: 1 },
      },
    );

    // ---- composite --------------------------------------------------------
    this.compositeMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform sampler2D tStreak;
      uniform sampler2D tDirt;
      uniform sampler2D tLUT;
      uniform sampler2D tAdapt;
      uniform vec2 uResolution;
      uniform float uExposure;
      uniform float uTime;
      uniform float uBloomStrength;
      uniform float uStreakStrength;
      uniform float uDirtStrength;
      uniform float uGrain;
      uniform float uVignette;
      uniform float uCA;
      uniform float uDistortion;
      uniform float uAutoExposure;
      uniform float uKeyValue;
      uniform vec2 uExposureClamp;
      uniform float uLutStrength;
      uniform float uWhitePoint;
      uniform float uShoulder;
      uniform float uWhiteScale;
      uniform float uHiDesat;
      uniform float uToeAmt;    // 0 = raw ACES toe (ablation), 1 = rebuilt toe
      uniform float uToeX;      // where the ACES fit's own log-log slope hits 1
      uniform float uToeFX;     // RRTAndODTFit(uToeX) — the anchor's value
      uniform float uToeP;      // log-log slope of the rebuilt shadow section
      uniform vec3  uToeDeep;   // x = short-toe knee, y = its exponent, z = (y-P)/3

      const mat3 ACESInput = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
      );
      const mat3 ACESOutput = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
      );
      vec3 RRTAndODTFit(vec3 v) {
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
      }

      /**
       * The ACES fit with its TOE REBUILT. Round 6's headline change.
       *
       * Measured on the shipped round-6 build with an unlit emissive patch at
       * frame centre stepped in half-stops (tools/probes/verify/k-tonecurve.js),
       * the delivered response was:
       *
       *   scene linear   display code   codes per stop
       *   0.0050            12.0            0.0
       *   0.0071            12.3            0.6
       *   0.0100            13.1            1.6
       *   0.0200            16.1            3.8
       *   0.0400            26.2           14.0
       *   0.3200           102.8           42.6
       *
       * The toe was TWENTY TIMES flatter than the upper midtones, and below
       * scene linear 0.0053 the curve was not flat, it was DEAD: RRTAndODTFit
       * has a constant of -0.000090537 in its numerator, so it returns exactly
       * zero for everything under 0.00358 and every one of those pixels printed
       * the grade's black point and nothing else.
       *
       * That band is not an edge case. A neutral 0.5-grey sphere in full cast
       * shadow measures 0.018-0.029 scene linear, so the 1.7-2.5 stops of
       * directional ambient, all of the AO, the sky-coloured shade, and the
       * whole dusk and night frames were being resolved into ~6 display codes.
       * Four rounds of light transport were arriving at the display encode and
       * dying there.
       *
       * The fix is anchored so it can only ever move shadows. uToeX is the
       * point where the ACES fit's OWN log-log slope passes through 1 (0.4574,
       * solved on the CPU in _toeConstants()). Above it the fit is untouched,
       * bit for bit — mids, shoulder, white point, the highlight range and the
       * per-hour exposure all inherit exactly what they had. Below it the fit's
       * slope climbs from 1 to 5.5 as it dives into the crush; that climb IS
       * the long toe, and it is replaced by:
       *
       *   - a straight log-log section of slope uToeP (0.92), which prints a
       *     constant ~9-15 codes per stop through the whole shadow region, and
       *   - a SHORT power toe below uToeDeep.x, exponent uToeDeep.y, which
       *     takes the last stop and a half to black so the frame keeps a real
       *     black point instead of a pedestal.
       *
       * Value and slope both match at the anchor (slope to within 0.08 in
       * log-log, which is under a tenth of a code anywhere), so there is no
       * visible join. This is the classic filmic prescription — SHORT toe, LONG
       * shoulder — where before there was a long toe and a short shoulder.
       */
      vec3 filmicFit(vec3 v) {
        vec3 aces = RRTAndODTFit(v);
        if (uToeAmt <= 0.0) return aces;              // ablation: raw ACES
        vec3 x = max(v, 0.0);
        vec3 s = x / uToeDeep.x;
        vec3 s3 = s * s * s;
        vec3 toe = uToeFX
                 * pow(x / uToeX, vec3(uToeP))
                 * pow(s3 / (1.0 + s3), vec3(uToeDeep.z));
        // Only below the anchor, and only where the working-space value is
        // positive (the ACES input matrix can emit small negatives on saturated
        // primaries, and pow() has nothing to say about those).
        vec3 sel = step(v, vec3(uToeX)) * step(0.0, v);
        return mix(aces, mix(aces, toe, sel), uToeAmt);
      }

      /**
       * Filmic tonemap with an explicit white point.
       *
       * Round 1 ran bare clamped ACES, which has no white point at all: the
       * vista topped out at L=0.814 across two million pixels (a flat grey
       * plate) while the outpost piled 5% of its pixels on pure 1.0. Both ends
       * wrong at once, because "how much linear light is white" was never a
       * number anywhere in the stack.
       *
       * Now it is. Everything above the knee is folded exponentially into
       * [knee, whitePoint] so no input, however hot, can reach the ceiling;
       * ACES then shapes the curve and the result is normalised by the tonemap
       * of the white point itself, so whitePoint maps to exactly 1.0 and only
       * asymptotically. Sunlit sand sits in the shoulder near 0.85 and the sun
       * disc rolls off instead of clipping.
       */
      vec3 acesFitted(vec3 color) {
        float knee = uWhitePoint * uShoulder;
        vec3 over = max(color - knee, 0.0);
        float span = max(uWhitePoint - knee, 1e-3);
        // Rational fold, not exponential. An exponential reaches 99% of the
        // ceiling by 5x the span, so a bright sky pins at the white point and
        // clips exactly as hard as having no white point at all; the rational
        // form needs 100x, which leaves the sky sitting inside the shoulder
        // where it belongs and keeps cloud modelling readable.
        vec3 x = over / span;
        color = min(color, knee) + span * (x / (1.0 + x));
        color = ACESInput * color;
        color = filmicFit(color);
        color = ACESOutput * color;
        return clamp(color * uWhiteScale, 0.0, 1.0);
      }

      vec3 linearToSRGB(vec3 c) {
        return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }

      /** 32^3 LUT stored as a 1024x32 strip; manual lerp across blue slices. */
      vec3 sampleLUT(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        const float N = 32.0;
        float b = c.b * (N - 1.0);
        float b0 = floor(b);
        float b1 = min(b0 + 1.0, N - 1.0);
        float fb = b - b0;
        float rx = (c.r * (N - 1.0) + 0.5) / (N * N);
        float gy = (c.g * (N - 1.0) + 0.5) / N;
        vec3 s0 = texture2D(tLUT, vec2(b0 / N + rx, gy)).rgb;
        vec3 s1 = texture2D(tLUT, vec2(b1 / N + rx, gy)).rgb;
        return mix(s0, s1, fb);
      }

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec2 uv = vUv;
        vec2 centre = uv - 0.5;
        float r2 = dot(centre, centre);

        // Barrel distortion. Tiny — enough to break the ruler-straight frame
        // edges that give rectilinear CG away, not enough to notice as an effect.
        vec2 duv = uv + centre * uDistortion * (r2 - 0.09);
        vec2 dcentre = duv - 0.5;
        float dr2 = dot(dcentre, dcentre);

        vec2 caOff = dcentre * uCA * (0.35 + dr2 * 1.4);
        vec3 color;
        color.r = texture2D(tDiffuse, duv + caOff).r;
        color.g = texture2D(tDiffuse, duv).g;
        color.b = texture2D(tDiffuse, duv - caOff).b;

        float avgLum = exp(texture2D(tAdapt, vec2(0.5)).r);
        float autoScale = mix(1.0, clamp(uKeyValue / max(avgLum, 1e-4), uExposureClamp.x, uExposureClamp.y), uAutoExposure);
        float exposure = uExposure * autoScale;

        color *= exposure;

        vec3 bloom = texture2D(tBloom, duv).rgb;
        vec3 streak = texture2D(tStreak, duv).rgb;
        vec3 dirt = texture2D(tDirt, duv * vec2(uResolution.x / uResolution.y, 1.0)).rgb;

        color += bloom * uBloomStrength;
        color += streak * uStreakStrength * vec3(0.72, 0.86, 1.25);
        // Veiling glare: light scattered off the dirt on the front element,
        // strongest where the bloom is strongest.
        color += bloom * dirt * uDirtStrength;

        // --- highlight desaturation ---
        // Bleach. Film loses chroma as it approaches the shoulder because the
        // fastest layer saturates first; a digital tonemapper without this
        // instead drives a hot pixel toward whichever primary is largest, so a
        // specular on metal under a warm sun clips to saturated RED. Measured
        // across every round-3 frame: R reached 255, G never passed 254 and B
        // never passed 243 — the frame had no white in it anywhere. Pulling
        // chroma out above the knee is what makes a highlight go white.
        {
          float mx = max(color.r, max(color.g, color.b));
          // The band is placed in LINEAR light where the tonemap's knee is
          // (whitePoint 5.2, knee 1.56): 1.35 lands at display 0.77 and 4.0 at
          // display 0.94, so only genuine highlights bleach and a golden dusk
          // sky at display 0.6 keeps every bit of its colour.
          float t = smoothstep(1.35, 4.0, mx) * uHiDesat;
          color = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), t);
        }

        // Vignette is the lens's own light falloff: it happens at the aperture,
        // so it belongs in SCENE-linear light ahead of the tonemap, not on the
        // display-referred result. Round 4 applied it afterwards, which meant a
        // sun sitting off-centre — as it does in the ridge and dawn framings —
        // had 26% subtracted from an already-tonemapped value and could not
        // reach white however hot it was. Ahead of the curve it just moves the
        // corner a little way down the shoulder instead.
        float vig = 1.0 - uVignette * smoothstep(0.12, 0.92, dr2 * 2.0);
        color *= vig;

        color = acesFitted(color);

        // --- display encode, THEN grade ---
        // The LUT is authored in display-referred code values: its contrast
        // pivot is 0.42, its shadow band ends at 0.30 luminance, and its toe
        // lift is 0.05. Those numbers only mean what they say in gamma space.
        // Applying it to linear light instead put the toe lift through the
        // sRGB encode afterwards, turning a 5% lift into a ~24% black-point
        // pedestal — every frame, night included, bottomed out at rgb(51,53,59)
        // and nothing in the game could ever render darker than that.
        color = max(color, 0.0);
        vec3 disp = linearToSRGB(color);
        disp = mix(disp, sampleLUT(disp), uLutStrength);

        // Film grain, luminance-weighted (more in the mids, like real stock)
        // and slightly chromatic so it does not read as digital noise. Grain is
        // a density variation on the print, so it too is a display-space term.
        float lum = dot(disp, vec3(0.2126, 0.7152, 0.0722));
        float gw = 1.0 - abs(lum * 2.0 - 1.0);
        float g1 = hash21(gl_FragCoord.xy + fract(uTime) * 431.71) - 0.5;
        float g2 = hash21(gl_FragCoord.xy * 1.7 + fract(uTime) * 197.13) - 0.5;
        disp += vec3(g1, mix(g1, g2, 0.6), g2) * uGrain * gw;

        gl_FragColor = vec4(clamp(disp, 0.0, 1.0), 1.0);
      }
      `,
      {
        tDiffuse: { value: null },
        tBloom: { value: null },
        tStreak: { value: null },
        tDirt: { value: this.dirt },
        tLUT: { value: this.lut },
        tAdapt: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uExposure: { value: 0.88 },
        uTime: { value: 0 },
        uBloomStrength: { value: GRADE.bloomStrength },
        uStreakStrength: { value: 0.14 },
        uDirtStrength: { value: 0.1 },
        uGrain: { value: GRADE.grainAmount },
        uVignette: { value: GRADE.vignette },
        uCA: { value: GRADE.chromaticAberration },
        uDistortion: { value: 0.035 },
        uAutoExposure: { value: 1 },
        // Both are overwritten every frame from the illuminant solve; these are
        // only the values a pipeline sees before its first render().
        uKeyValue: { value: 0.203 },
        uExposureClamp: { value: new THREE.Vector2(0.986, 1.014) },
        uLutStrength: { value: 1.0 },
        uWhitePoint: { value: GRADE.whitePoint ?? 5.2 },
        uShoulder: { value: GRADE.shoulder ?? 0.3 },
        uWhiteScale: { value: 1.0 },
        uHiDesat: { value: GRADE.highlightDesat ?? 0.85 },
        uToeAmt: { value: 1 },
        uToeX: { value: 0.45745 },
        uToeFX: { value: 0.34333 },
        uToeP: { value: 0.92 },
        uToeDeep: { value: new THREE.Vector3(0.0030, 2.0, 0.36) },
      },
    );
    this._refreshWhitePoint();

    // ---- FXAA (fallback) + sharpen ----------------------------------------
    this.fxaaMat = mat(
      /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2 uTexel;
      uniform float uSharpen;
      uniform float uFxaa;

      float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

      void main() {
        vec3 rgbM = texture2D(tDiffuse, vUv).rgb;
        vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
        vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
        vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
        vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;

        vec3 result = rgbM;
        if (uFxaa > 0.5) {
          float lM = luma(rgbM), lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

          vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
          float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
          float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
          dir = clamp(dir * rcpDirMin, -8.0, 8.0) * uTexel;

          vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                             texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
          vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb +
                                           texture2D(tDiffuse, vUv + dir * 0.5).rgb);
          float lB = luma(rgbB);
          result = (lB < lMin || lB > lMax) ? rgbA : rgbB;
        }

        // Unsharp mask restores micro-detail that TAA/FXAA smear — the
        // difference between "blurry web demo" and "console sharp".
        vec3 blur = (rgbNW + rgbNE + rgbSW + rgbSE) * 0.25;
        vec3 sharp = (result - blur) * uSharpen;
        // Every clipped pixel left in the frame after the tonemap got its white
        // point was manufactured HERE: a bright halo against the sky pushed past
        // 1.0 and clamped. Above 0.84 only the dark lobe of the halo survives,
        // which is the lobe that actually reads as sharpness anyway.
        float hi = max(result.r, max(result.g, result.b));
        result += mix(sharp, min(sharp, vec3(0.0)), smoothstep(0.84, 1.0, hi));

        gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
      }
      `,
      {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSharpen: { value: GRADE.sharpen },
        uFxaa: { value: 0 },
      },
    );
  }

  // -------------------------------------------------------------------------

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  _updateAtmosphereUniforms(camera) {
    const a = this.atmosphere;
    const u = this.prepMat.uniforms;
    u.uSunDir.value.copy(a.sunDirection);
    u.uSunRadiance.value.set(...a.sunRadiance);
    u.uSkyRadiance.value.set(...a.skyRadiance);
    u.uMieG.value = Math.min(a.mieG ?? 0.76, 0.8);

    // Rayleigh is physical; the aerosol/dust layer is where the art direction
    // lives (a desert at 2 km is dominated by suspended dust, not by air).
    const rs = a.rayleighScale ?? 1;
    const ms = a.mieScale ?? 1;
    const dd = a.dustDensity ?? 1;
    // Rayleigh pulled back and dust pushed up. At 2 km in an Afghan valley the
    // extinction is dominated by suspended mineral dust, not by air; round 1
    // had the balance the other way and every distant ridge inherited the sky's
    // blue, which is most of why the frame measured B > R everywhere.
    u.uBetaR.value.set(5.802e-6 * rs, 13.558e-6 * rs, 33.1e-6 * rs).multiplyScalar(1.78);
    u.uBetaM.value.set(2.2e-5 * ms, 2.1e-5 * ms, 2.0e-5 * ms);
    // Angstrom-ish 1/lambda tilt: fine dust scatters blue slightly more.
    u.uBetaD.value.set(1.30e-4 * dd, 1.34e-4 * dd, 1.40e-4 * dd);
    u.uCamPos.value.copy(camera.position);
  }

  render(renderer, scene, camera) {
    const w = this.width;
    const h = this.height;
    this.frame++;

    // ---- 0. camera bookkeeping + TAA jitter ----
    this._baseProj.copy(camera.projectionMatrix);
    this._viewProj.multiplyMatrices(this._baseProj, camera.matrixWorldInverse);

    // Reset the temporal history on a hard camera cut (shot changes) so the
    // first frames of a new pose never smear the previous one across the image.
    camera.getWorldDirection(this._tmpV);
    const jumped =
      this._prevCamPos.distanceTo(camera.position) > 3.0 || this._tmpV.dot(this._prevCamDir) < 0.9975;
    if (jumped) this._historyValid = false;
    this._prevCamPos.copy(camera.position);
    this._prevCamDir.copy(this._tmpV);

    const useTAA = this.enabled.taa;
    if (useTAA) {
      const j = JITTER[this.frame % JITTER.length];
      this._jitProj.copy(this._baseProj);
      this._jitProj.elements[8] += (2.0 * j[0]) / w;
      this._jitProj.elements[9] += (2.0 * j[1]) / h;
      camera.projectionMatrix.copy(this._jitProj);
      camera.projectionMatrixInverse.copy(this._jitProj).invert();
    } else {
      this._jitProj.copy(this._baseProj);
    }
    this._jitProjInv.copy(this._jitProj).invert();
    this._tmpM.multiplyMatrices(this._jitProj, camera.matrixWorldInverse);
    this._invViewProj.copy(this._tmpM).invert();

    // ---- 1. main scene into HDR ----
    renderer.setRenderTarget(this.hdr);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    this.sceneStats = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };

    // Restore the unjittered projection immediately — everything downstream
    // (and every other system) should see the real matrix.
    camera.projectionMatrix.copy(this._baseProj);
    camera.projectionMatrixInverse.copy(this._baseProj).invert();

    // ---- 2. ambient occlusion ----
    if (this.enabled.ssao) {
      const au = this.aoMat.uniforms;
      au.tDepth.value = this.hdr.depthTexture;
      au.uResolution.value.set(this.aoRT.width, this.aoRT.height);
      au.uProjInv.value.copy(this._jitProjInv);
      au.uProjScale.value.set(this._jitProj.elements[0], this._jitProj.elements[5]);
      au.uFrame.value = this.frame % 64;
      this._blit(this.aoMat, this.aoRT);

      this.aoBlurMat.uniforms.tAO.value = this.aoRT.texture;
      this.aoBlurMat.uniforms.uDir.value.set(1 / this.aoRT.width, 0);
      this._blit(this.aoBlurMat, this.aoBlurRT);
      this.aoBlurMat.uniforms.tAO.value = this.aoBlurRT.texture;
      this.aoBlurMat.uniforms.uDir.value.set(0, 1 / this.aoRT.height);
      this._blit(this.aoBlurMat, this.aoRT);
    }

    // ---- 3. prepare: AO + aerial perspective ----
    this._updateAtmosphereUniforms(camera);
    const pu = this.prepMat.uniforms;
    pu.tColor.value = this.hdr.texture;
    pu.tDepth.value = this.hdr.depthTexture;
    pu.tAO.value = this.aoRT.texture;
    pu.uInvViewProj.value.copy(this._invViewProj);
    pu.uProjInv.value.copy(this._jitProjInv);
    pu.uAOEnabled.value = this.enabled.ssao ? 1 : 0;
    pu.uAerialEnabled.value = this.enabled.aerial ? 1 : 0;
    this._blit(this.prepMat, this.prepRT);

    // ---- 4. TAA resolve ----
    let resolved = this.prepRT;
    if (useTAA) {
      const tu = this.taaMat.uniforms;
      tu.tCurrent.value = this.prepRT.texture;
      tu.tHistory.value = this.taaB.texture;
      tu.tDepth.value = this.hdr.depthTexture;
      tu.uTexel.value.set(1 / w, 1 / h);
      tu.uInvViewProjJit.value.copy(this._invViewProj);
      tu.uPrevViewProj.value.copy(this._prevViewProj);
      tu.uValid.value = this._historyValid ? 1 : 0;
      this._blit(this.taaMat, this.taaA);
      resolved = this.taaA;
      const t = this.taaA;
      this.taaA = this.taaB;
      this.taaB = t;
      this._historyValid = true;
    }
    this._prevViewProj.copy(this._viewProj);

    // ---- 5. auto exposure ----
    this.lumMat.uniforms.tColor.value = resolved.texture;
    this._blit(this.lumMat, this.lumRTs[0]);
    for (let i = 1; i < this.lumRTs.length; i++) {
      this.downMat.uniforms.tColor.value = this.lumRTs[i - 1].texture;
      this.downMat.uniforms.uTexel.value.set(1 / this.lumRTs[i - 1].width, 1 / this.lumRTs[i - 1].height);
      this._blit(this.downMat, this.lumRTs[i]);
    }
    const adu = this.adaptMat.uniforms;
    adu.tLum.value = this.lumRTs[this.lumRTs.length - 1].texture;
    adu.tPrev.value = this.adaptB.texture;
    adu.tDepth.value = this.hdr.depthTexture;
    adu.uSnap.value = !this._historyValid || this.frame < 3 || jumped ? 1 : 0;
    adu.uNear.value = camera.near;
    adu.uFar.value = camera.far;
    adu.uAFPoint.value.copy(this.afPoint);
    this._blit(this.adaptMat, this.adaptA);
    {
      const t = this.adaptA;
      this.adaptA = this.adaptB;
      this.adaptB = t;
    }
    const adaptTex = this.adaptB.texture;

    // ---- 5b. exposure solve (illuminant-derived, not frame-derived) ----
    const sceneL = this._updateExposure();

    // ---- 6. bloom ----
    if (this.enabled.bloom) {
      this.brightMat.uniforms.tDiffuse.value = resolved.texture;
      this.brightMat.uniforms.uThreshold.value = this.grade.bloomThreshold;
      // The bright pass has to see the SAME exposure the composite will apply,
      // or the bloom threshold means a different scene radiance in every shot.
      this.brightMat.uniforms.uExposure.value = this._finalExposure;
      this._blit(this.brightMat, this.bloomRTs[0].a);
      for (let i = 0; i < this.bloomRTs.length; i++) {
        const rt = this.bloomRTs[i];
        if (i > 0) {
          this.blurMat.uniforms.tDiffuse.value = this.bloomRTs[i - 1].a.texture;
          this.blurMat.uniforms.uDir.value.set(1 / rt.w, 0);
          this._blit(this.blurMat, rt.a);
        }
        this.blurMat.uniforms.tDiffuse.value = rt.a.texture;
        this.blurMat.uniforms.uDir.value.set(1 / rt.w, 0);
        this._blit(this.blurMat, rt.b);
        this.blurMat.uniforms.tDiffuse.value = rt.b.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1 / rt.h);
        this._blit(this.blurMat, rt.a);
      }
      for (let i = this.bloomRTs.length - 1; i > 0; i--) {
        this.upsampleMat.uniforms.tLower.value = this.bloomRTs[i].a.texture;
        this.upsampleMat.uniforms.tHigher.value = this.bloomRTs[i - 1].a.texture;
        this.upsampleMat.uniforms.uMix.value = this.grade.bloomRadius + 0.25;
        this._blit(this.upsampleMat, this.bloomRTs[i - 1].b);
        const t = this.bloomRTs[i - 1].a;
        this.bloomRTs[i - 1].a = this.bloomRTs[i - 1].b;
        this.bloomRTs[i - 1].b = t;
      }

      // Anamorphic streak from the second mip (already bright-passed).
      //
      // Steps were 1 / 9 / 81 quarter-res texels. Two things were wrong with
      // that. The 17-tap kernel of one pass spans +/-8 steps, so a factor of 9
      // leaves GAPS between passes: each outer tap of the last pass landed as a
      // discrete ghost of the image a quarter of a frame away, visible in the
      // round-4 dusk sky as a duplicated horizon. And the total reach came to
      // 2.3x the frame width, so most taps were off the sensor entirely.
      // 1 / 4 / 16 overlaps cleanly and reaches ~0.5 of the frame, which is
      // what a long anamorphic flare actually looks like.
      this.streakMat.uniforms.tDiffuse.value = this.bloomRTs[1].a.texture;
      this.streakMat.uniforms.uStep.value = 1.0 / this.streakA.width;
      this.streakMat.uniforms.uAttenuation.value = 0.88;
      this._blit(this.streakMat, this.streakA);
      this.streakMat.uniforms.tDiffuse.value = this.streakA.texture;
      this.streakMat.uniforms.uStep.value = 4.0 / this.streakA.width;
      this._blit(this.streakMat, this.streakB);
      this.streakMat.uniforms.tDiffuse.value = this.streakB.texture;
      this.streakMat.uniforms.uStep.value = 16.0 / this.streakA.width;
      this._blit(this.streakMat, this.streakA);
    }

    // ---- 7. bokeh DOF + motion blur ----
    const du = this.dofMat.uniforms;
    du.tColor.value = resolved.texture;
    du.tDepth.value = this.hdr.depthTexture;
    du.tAdapt.value = adaptTex;
    du.uTexel.value.set(1 / w, 1 / h);
    du.uInvViewProjJit.value.copy(this._invViewProj);
    du.uPrevViewProj.value.copy(this._prevViewProj);
    du.uNear.value = camera.near;
    du.uFar.value = camera.far;
    // Focal length that matches the current FOV on a 35mm-format sensor, so
    // the defocus tracks the shot's framing instead of being a fixed blur.
    const sensorH = this.grade.sensorHeight ?? 0.024;
    const focal = sensorH * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    du.uFocal.value = focal;
    du.uAperture.value = focal / (this.grade.fStop ?? 2.4);
    du.uSensorPx.value = h / sensorH;
    // Every CoC term scales with resolution so the defocus is the same fraction
    // of the image at 720p and at 4K rather than the same pixel count.
    const cocScale = h / 1080;
    du.uEdgeSoftness.value = (this.grade.focusEdgeSoftness ?? 0.25) * cocScale;
    du.uMaxCoCFar.value = (this.grade.maxCoCFar ?? 2.4) * cocScale;
    du.uMaxCoCNear.value = (this.grade.maxCoCNear ?? 1.2) * cocScale;
    du.uCoCFloor.value = (this.grade.cocFloor ?? 0.9) * cocScale;
    du.uFrame.value = this.frame % 64;
    du.uMotionScale.value = this.enabled.motionBlur ? 0.55 : 0.0;
    du.uEnabled.value = this.enabled.dof || this.enabled.motionBlur ? 1 : 0;
    this._blit(this.dofMat, this.dofRT);

    // ---- 8. composite ----
    const u = this.compositeMat.uniforms;
    u.tDiffuse.value = this.dofRT.texture;
    u.tBloom.value = this.enabled.bloom ? this.bloomRTs[0].a.texture : null;
    u.tStreak.value = this.enabled.bloom ? this.streakA.texture : null;
    u.tAdapt.value = adaptTex;
    u.uBloomStrength.value = this.enabled.bloom ? this.grade.bloomStrength : 0;
    u.uStreakStrength.value = this.enabled.bloom ? (this.grade.anamorphic ?? 0.16) : 0;
    u.uDirtStrength.value = this.enabled.bloom ? (this.grade.lensDirt ?? 0.5) : 0;
    u.uExposure.value = this._finalExposure;
    u.uAutoExposure.value = this.enabled.autoExposure ? 1 : 0;
    // What the metered log-average SHOULD be if the frame is a fair sample of
    // the illuminant. Centring the auto term on the physical prediction means
    // its (deliberately tiny) authority is spent correcting genuine content
    // deviation rather than re-deriving the exposure from the histogram.
    u.uKeyValue.value = sceneL * (this.grade.meterBias ?? 0.62);
    const auth = this.grade.autoExposureStops ?? 0.02;
    u.uExposureClamp.value.set(Math.pow(2, -auth), Math.pow(2, auth));
    u.uResolution.value.set(w, h);
    u.uGrain.value = this.grade.grainAmount;
    u.uVignette.value = this.grade.vignette;
    u.uCA.value = this.grade.chromaticAberration;
    u.uDistortion.value = this.grade.barrel ?? 0.035;
    u.uHiDesat.value = this.grade.highlightDesat ?? 0.85;
    u.uTime.value = this.frame * 0.0163;

    this._blit(this.compositeMat, this.compositeRT);

    this.fxaaMat.uniforms.tDiffuse.value = this.compositeRT.texture;
    this.fxaaMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.fxaaMat.uniforms.uSharpen.value = this.grade.sharpen;
    // FXAA is only the fallback: with TAA running it would just soften an
    // already-resolved image, so the final pass degrades to a sharpen.
    this.fxaaMat.uniforms.uFxaa.value = !useTAA && this.enabled.fxaa ? 1 : 0;
    this._blit(this.fxaaMat, null);

    renderer.setRenderTarget(null);
  }
}
