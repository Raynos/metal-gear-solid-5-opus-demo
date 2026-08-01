#!/usr/bin/env node
/**
 * scan.mjs — row/box statistics on a PNG.
 *   node scan.mjs row  file.png y x0 x1        # print a row of sRGB values
 *   node scan.mjs box  file.png x0 y0 x1 y1    # stats over a box
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const [, , cmd, file, ...rest] = process.argv;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<canvas id=c></canvas>');
const buf = await readFile(file);
const dim = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.getElementById('c');
  c.width = img.width; c.height = img.height;
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  return { w: img.width, h: img.height };
}, buf.toString('base64'));

const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const lum = (r, g, b) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);

if (cmd === 'row') {
  const [y, x0, x1] = rest.map(Number);
  const d = await page.evaluate(({ y, x0, x1 }) => {
    const g = document.getElementById('c').getContext('2d', { willReadFrequently: true });
    return Array.from(g.getImageData(x0, y, x1 - x0, 1).data);
  }, { y, x0, x1 });
  const vals = [];
  for (let i = 0; i < d.length; i += 4) vals.push(Math.round(lum(d[i], d[i + 1], d[i + 2]) * 1000) / 1000);
  const g8 = [];
  for (let i = 0; i < d.length; i += 4) g8.push(d[i + 1]);
  console.log(`y=${y} x ${x0}..${x1}`);
  console.log('G8 :', g8.join(','));
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  // local contrast: mean |delta| between adjacent px
  let dsum = 0; for (let i = 1; i < vals.length; i++) dsum += Math.abs(vals[i] - vals[i - 1]);
  console.log(`lum min ${mn.toFixed(4)} max ${mx.toFixed(4)} mean ${mean.toFixed(4)} sd ${sd.toFixed(4)} adjDelta ${(dsum / (vals.length - 1)).toFixed(5)} range ${(mx - mn).toFixed(4)}`);
} else if (cmd === 'box') {
  const [x0, y0, x1, y1] = rest.map(Number);
  const d = await page.evaluate(({ x0, y0, w, h }) => {
    const g = document.getElementById('c').getContext('2d', { willReadFrequently: true });
    return Array.from(g.getImageData(x0, y0, w, h).data);
  }, { x0, y0, w: x1 - x0, h: y1 - y0 });
  const L = [], R = [], G = [], B = [];
  for (let i = 0; i < d.length; i += 4) { L.push(lum(d[i], d[i + 1], d[i + 2])); R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const s = L.slice().sort((a, b) => a - b);
  const mean = avg(L);
  const sd = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / L.length);
  console.log(`box ${x0},${y0} ${x1 - x0}x${y1 - y0}  n=${L.length}`);
  console.log(`  lum mean ${mean.toFixed(4)} sd ${sd.toFixed(4)} (cv ${(sd / mean).toFixed(3)})  p01 ${s[Math.floor(s.length * 0.01)].toFixed(4)} p50 ${s[Math.floor(s.length * 0.5)].toFixed(4)} p99 ${s[Math.floor(s.length * 0.99)].toFixed(4)}`);
  console.log(`  sRGB mean R${avg(R).toFixed(1)} G${avg(G).toFixed(1)} B${avg(B).toFixed(1)}  R-B ${(avg(R) - avg(B)).toFixed(1)}`);
}
console.log(`(image ${dim.w}x${dim.h})`);
await browser.close();
