#!/usr/bin/env node
/**
 * pix.mjs — offline pixel inspection for the canonical shots.
 *
 *   node tools/pix.mjs stats shots/r2/*.png              # channel means per shot
 *   node tools/pix.mjs crop shots/r2/ground.png 1030 810 220 160 3 out.png
 *   node tools/pix.mjs probe shots/r2/vista.png 100,200 300,400
 *   node tools/pix.mjs column shots/r2/vista.png 1690 0.02,0.12,0.25,0.40
 *
 * Decodes with a headless Chromium canvas (no image deps in the repo) so the
 * critic's coordinates can be checked against the same PNGs that ship.
 */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [, , cmd, ...rest] = process.argv;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<canvas id=c></canvas>');

async function load(file) {
  const buf = await readFile(file);
  const b64 = buf.toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    window.__img = img;
    return { w: img.width, h: img.height };
  }, b64);
}

function srgbToLin(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

if (cmd === 'stats') {
  const rows = [];
  for (const f of rest) {
    await load(f);
    const s = await page.evaluate(() => {
      const c = document.getElementById('c');
      const g = c.getContext('2d', { willReadFrequently: true });
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let r = 0, gg = 0, b = 0, n = 0, clip = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
        if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) clip++;
      }
      return { r: r / n, g: gg / n, b: b / n, clip: clip / n };
    });
    rows.push({
      shot: path.basename(f, '.png'),
      R: +s.r.toFixed(1), G: +s.g.toFixed(1), B: +s.b.toFixed(1),
      'R-B': +(s.r - s.b).toFixed(1),
      clipPct: +(s.clip * 100).toFixed(2),
    });
  }
  console.table(rows);
} else if (cmd === 'crop') {
  const [file, x, y, w, h, scale, out] = rest;
  await load(file);
  const b64 = await page.evaluate(({ x, y, w, h, s }) => {
    const src = document.getElementById('c');
    const o = document.createElement('canvas');
    o.width = w * s; o.height = h * s;
    const g = o.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, x, y, w, h, 0, 0, w * s, h * s);
    return o.toDataURL('image/png').split(',')[1];
  }, { x: +x, y: +y, w: +w, h: +h, s: +scale });
  await writeFile(out, Buffer.from(b64, 'base64'));
  console.log(out);
} else if (cmd === 'probe') {
  const file = rest[0];
  const { w, h } = await load(file);
  const pts = rest.slice(1).map((s) => s.split(',').map(Number));
  const vals = await page.evaluate((pts) => {
    const c = document.getElementById('c');
    const g = c.getContext('2d', { willReadFrequently: true });
    return pts.map(([x, y]) => {
      // 5x5 median-ish: mean of the patch, robust to grain.
      const d = g.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      return [r / n, gg / n, b / n];
    });
  }, pts);
  for (let i = 0; i < pts.length; i++) {
    const [r, g, b] = vals[i];
    const lin = [r, g, b].map((v) => srgbToLin(v / 255));
    const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    console.log(
      `${pts[i].join(',')}  sRGB ${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}` +
      `  B-R(norm) ${((b - r) / 255).toFixed(3)}  B/R(lin) ${(lin[2] / Math.max(lin[0], 1e-6)).toFixed(2)}` +
      `  lum(lin) ${lum.toFixed(4)}`,
    );
  }
  console.log(`(image ${w}x${h})`);
} else if (cmd === 'column') {
  const [file, xs, fracs] = rest;
  const { w, h } = await load(file);
  const x = xs.includes('.') ? Math.round(+xs * w) : +xs;
  const list = fracs.split(',').map(Number);
  const vals = await page.evaluate(({ x, ys }) => {
    const c = document.getElementById('c');
    const g = c.getContext('2d', { willReadFrequently: true });
    return ys.map((y) => {
      const d = g.getImageData(x - 4, y - 4, 9, 9).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      return [r / n, gg / n, b / n];
    });
  }, { x, ys: list.map((f) => Math.round(f * h)) });
  console.log(`column x=${x} of ${w}x${h}`);
  for (let i = 0; i < list.length; i++) {
    const [r, g, b] = vals[i];
    const lin = [r, g, b].map((v) => srgbToLin(v / 255));
    console.log(
      `  y=${(list[i] * 100).toFixed(0).padStart(3)}%  sRGB ${r.toFixed(0).padStart(3)},${g.toFixed(0).padStart(3)},${b.toFixed(0).padStart(3)}` +
      `  B-R ${((b - r) / 255).toFixed(3)}  lum ${(0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]).toFixed(3)}`,
    );
  }
}

await browser.close();
