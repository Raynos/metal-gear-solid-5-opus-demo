import * as THREE from 'three';

/**
 * Canvas-generated masks. Chain-link and camo netting are the two things in the
 * compound that are mostly holes; punching them with alpha is an order of
 * magnitude cheaper than modelling wire, and mip-mapping gives free LOD.
 */

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function finish(c, { aniso = 8, repeat = [1, 1] } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.repeat.set(repeat[0], repeat[1]);
  t.needsUpdate = true;
  return t;
}

/** Galvanised chain-link diamond mesh, tileable. */
export function chainLinkTexture() {
  const S = 128;
  const c = canvas(S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.lineCap = 'round';
  const draw = (dir, shade) => {
    g.strokeStyle = shade;
    g.lineWidth = 3.2;
    for (let i = -2; i <= 4; i++) {
      g.beginPath();
      const o = (i * S) / 2;
      if (dir > 0) {
        g.moveTo(o, 0);
        g.lineTo(o + S, S);
      } else {
        g.moveTo(o, S);
        g.lineTo(o + S, 0);
      }
      g.stroke();
    }
  };
  draw(1, 'rgba(196,199,201,1)');
  draw(-1, 'rgba(150,153,156,1)');
  // Soften so the alpha mips degrade to a haze rather than vanishing.
  g.globalAlpha = 0.35;
  g.filter = 'blur(1px)';
  g.drawImage(c, 0, 0);
  return finish(c);
}

/**
 * Desert camo netting: garnished scrim over an open hexagonal support net.
 *
 * The controlling number here is the OPEN FRACTION, and round 1 got it wrong:
 * a scrim that is 90% closed is a tarpaulin. A real garnished net is roughly
 * 40% open, in holes 5–20cm across — big enough that a 2048 cascade covering
 * 40m resolves each one, which is the only reason the dappled shadow it throws
 * on the ground exists at all. Everything else about the net is downstream of
 * that: get the holes too small and the shadow collapses to a flat grey slab.
 */
export function camoNetTexture() {
  const S = 512;
  const c = canvas(S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Value-only: the desert/olive colour comes from the material, so the same
  // texture can be re-tinted without regenerating it.
  const tones = ['#c9c9c9', '#9d9d9d', '#e6e6e6', '#7c7c7c', '#bdbdbd'];

  // 1. The knotted support net itself — a thin, unbroken diamond grid. Without
  //    it the garnish reads as floating confetti when the sun is behind it.
  g.strokeStyle = 'rgba(158,158,158,1)';
  g.lineWidth = 3.0;
  const cell = S / 6;
  for (let i = -6; i <= 12; i++) {
    g.beginPath();
    g.moveTo(i * cell, 0);
    g.lineTo(i * cell + S, S);
    g.stroke();
    g.beginPath();
    g.moveTo(i * cell, S);
    g.lineTo(i * cell + S, 0);
    g.stroke();
  }

  // 2. Garnish: clumps of cut strip tied to the net, tufted around the knots so
  //    the открытая middle of each diamond stays open.
  const tuft = (cx, cy, n, spread) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.6) * spread;
      const w = 16 + rnd() * 36;
      const h = 6 + rnd() * 12;
      g.save();
      g.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.rotate(rnd() * Math.PI);
      g.fillStyle = tones[(rnd() * tones.length) | 0];
      g.globalAlpha = 0.72 + rnd() * 0.28;
      g.beginPath();
      g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  };
  for (let j = -1; j <= 12; j++) {
    for (let i = -1; i <= 12; i++) {
      const cx = i * (cell / 2);
      const cy = j * (cell / 2);
      if (((i + j) & 1) !== 0) continue;
      // Skip a fifth of the knots outright: the net was cut and re-tied.
      if (rnd() < 0.10) continue;
      tuft(cx, cy, 11 + ((rnd() * 8) | 0), cell * 0.42);
    }
  }

  // 3. Punch the open field back out — this is what sets the 40% figure. Holes
  //    are centred on the *middle* of the diamonds, where a real net is bare.
  g.globalCompositeOperation = 'destination-out';
  for (let j = -1; j <= 12; j++) {
    for (let i = -1; i <= 12; i++) {
      if (((i + j) & 1) === 0) continue;
      const cx = i * (cell / 2) + (rnd() - 0.5) * 8;
      const cy = j * (cell / 2) + (rnd() - 0.5) * 8;
      g.globalAlpha = 0.55 + rnd() * 0.45;
      g.beginPath();
      g.ellipse(cx, cy, cell * (0.13 + rnd() * 0.13), cell * (0.12 + rnd() * 0.13), rnd() * 3.14, 0, Math.PI * 2);
      g.fill();
    }
  }
  // A few big tears where a vehicle has caught it.
  for (let i = 0; i < 5; i++) {
    g.globalAlpha = 1.0;
    g.beginPath();
    g.ellipse(rnd() * S, rnd() * S, 12 + rnd() * 26, 8 + rnd() * 18, rnd() * 3.14, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  return finish(c);
}

/**
 * Stencilled unit markings, as one atlas of 4x4 cells.
 *
 * Signage is the cheapest AAA cue in the set-dressing budget: two painted
 * characters on a wall tell the eye "somebody administers this place", which is
 * exactly the read that separates a military installation from a pile of grey
 * boxes. Cyrillic, stencil-cut, hand-painted crooked, and half weathered away.
 */
export function signTexture() {
  const S = 1024;
  const N = 4;
  const CELL = S / N;
  const c = canvas(S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  let seed = 19;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const cellAt = (i) => [(i % N) * CELL, Math.floor(i / N) * CELL];

  const text = (i, str, { size = 64, col = '#e8e6de', y = 0.5, tilt = 0.012, weight = 700 } = {}) => {
    const [ox, oy] = cellAt(i);
    g.save();
    g.beginPath();
    g.rect(ox, oy, CELL, CELL);
    g.clip();
    g.translate(ox + CELL / 2, oy + CELL * y);
    g.rotate(tilt);
    g.fillStyle = col;
    g.font = `${weight} ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(str, 0, 0);
    // Stencil bridges: knock a few horizontal slots through the glyphs.
    g.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 3; k++) {
      g.fillRect(-CELL / 2, -size * 0.42 + k * size * 0.34, CELL, size * 0.045);
    }
    g.restore();
    g.globalCompositeOperation = 'source-over';
  };

  const weatherCell = (i, amount) => {
    const [ox, oy] = cellAt(i);
    g.save();
    g.beginPath();
    g.rect(ox, oy, CELL, CELL);
    g.clip();
    g.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 240 * amount; k++) {
      g.globalAlpha = 0.25 + rnd() * 0.65;
      g.beginPath();
      g.ellipse(ox + rnd() * CELL, oy + rnd() * CELL, 2 + rnd() * 16, 2 + rnd() * 12, rnd() * 3.14, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    g.globalCompositeOperation = 'source-over';
  };

  // 0-3: building identifiers and stores markings.
  text(0, 'КАЗАРМА', { size: 52 });
  text(1, 'СКЛАД № 4', { size: 50, tilt: -0.02 });
  text(2, 'ШТАБ', { size: 78, tilt: 0.008 });
  text(3, 'ГСМ', { size: 82, col: '#e6d9a8' });
  // 4-7: hazard and control.
  text(4, 'ОПАСНО', { size: 56, col: '#d8483a' });
  text(5, 'СТОЙ', { size: 82, col: '#d8483a' });
  text(6, 'НЕ КУРИТЬ', { size: 46, col: '#d8483a', tilt: -0.015 });
  text(7, 'ПОСТ № 2', { size: 50 });
  // 8-11: big painted numerals — the workhorse decal on any depot wall.
  text(8, '27', { size: 150, weight: 800 });
  text(9, '14', { size: 150, weight: 800, tilt: -0.02 });
  text(10, '03', { size: 150, weight: 800 });
  text(11, 'B-7', { size: 130, weight: 800 });

  // 12: red star. 13: chevron flash. 14: directional arrow. 15: yellow hazard bars.
  {
    const [ox, oy] = cellAt(12);
    g.save();
    g.translate(ox + CELL / 2, oy + CELL / 2);
    g.fillStyle = '#c0392b';
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
      const r = k % 2 === 0 ? CELL * 0.42 : CELL * 0.175;
      if (k === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
    g.restore();
  }
  {
    const [ox, oy] = cellAt(13);
    g.save();
    g.translate(ox, oy);
    for (let k = 0; k < 3; k++) {
      g.fillStyle = ['#d8d3c4', '#7d8a5c', '#d8d3c4'][k];
      g.beginPath();
      g.moveTo(CELL * 0.12, CELL * (0.22 + k * 0.2));
      g.lineTo(CELL * 0.5, CELL * (0.08 + k * 0.2));
      g.lineTo(CELL * 0.88, CELL * (0.22 + k * 0.2));
      g.lineTo(CELL * 0.88, CELL * (0.30 + k * 0.2));
      g.lineTo(CELL * 0.5, CELL * (0.16 + k * 0.2));
      g.lineTo(CELL * 0.12, CELL * (0.30 + k * 0.2));
      g.closePath();
      g.fill();
    }
    g.restore();
  }
  {
    const [ox, oy] = cellAt(14);
    g.save();
    g.translate(ox + CELL / 2, oy + CELL / 2);
    g.fillStyle = '#e8e6de';
    g.fillRect(-CELL * 0.36, -CELL * 0.08, CELL * 0.52, CELL * 0.16);
    g.beginPath();
    g.moveTo(CELL * 0.40, 0);
    g.lineTo(CELL * 0.10, -CELL * 0.26);
    g.lineTo(CELL * 0.10, CELL * 0.26);
    g.closePath();
    g.fill();
    g.restore();
  }
  {
    const [ox, oy] = cellAt(15);
    g.save();
    g.beginPath();
    g.rect(ox, oy, CELL, CELL);
    g.clip();
    for (let k = -4; k < 10; k++) {
      g.fillStyle = k % 2 === 0 ? '#c9a227' : '#22201c';
      g.save();
      g.translate(ox, oy);
      g.beginPath();
      g.moveTo(k * CELL * 0.18, 0);
      g.lineTo(k * CELL * 0.18 + CELL * 0.18, 0);
      g.lineTo(k * CELL * 0.18 + CELL * 0.18 + CELL, CELL);
      g.lineTo(k * CELL * 0.18 + CELL, CELL);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.restore();
  }

  for (let i = 0; i < 16; i++) weatherCell(i, 0.35 + rnd() * 0.75);
  const t = finish(c, { aniso: 8 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Soft round falloff — used to feather the outboard end of the approach track. */
export function edgeFadeTexture() {
  const S = 64;
  const c = canvas(S);
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.72, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = finish(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
