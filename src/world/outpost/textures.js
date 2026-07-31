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

/** Desert camo netting: garnished scrim with irregular gaps. */
export function camoNetTexture() {
  const S = 256;
  const c = canvas(S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Value-only: the desert/olive colour comes from the material, so the same
  // texture can be re-tinted without regenerating it.
  const tones = ['#c9c9c9', '#a6a6a6', '#e2e2e2', '#8a8a8a', '#bdbdbd'];
  // Overlapping garnish strips: dense enough to read as shade cloth, open enough
  // to show sky through.
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const w = 6 + rnd() * 20;
    const h = 3 + rnd() * 8;
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * Math.PI);
    g.fillStyle = tones[(rnd() * tones.length) | 0];
    g.globalAlpha = 0.55 + rnd() * 0.45;
    g.beginPath();
    g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // Punch a few genuine holes so the net reads as damaged, not as a tarp.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 42; i++) {
    g.globalAlpha = 0.45 + rnd() * 0.45;
    g.beginPath();
    g.ellipse(rnd() * S, rnd() * S, 4 + rnd() * 13, 4 + rnd() * 10, rnd() * 3.14, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
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
