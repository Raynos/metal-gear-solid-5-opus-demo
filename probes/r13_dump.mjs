/**
 * r13_dump.mjs — write the data URLs a probe returned out as PNGs.
 *
 *   node tools/shot.mjs eval probes/<p>.js > out.json && node probes/r13_dump.mjs out.json <dir>
 *
 * shot.mjs prints a banner line before the JSON, so the object is located by its
 * first `{` rather than by parsing the whole stream.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , src, dir = 'shots/dump'] = process.argv;
const raw = readFileSync(src, 'utf8');
const obj = JSON.parse(raw.slice(raw.indexOf('{')));
mkdirSync(dir, { recursive: true });
for (const [k, v] of Object.entries(obj)) {
  if (typeof v !== 'string' || !v.startsWith('data:image')) continue;
  const file = path.join(dir, `${k}.png`);
  writeFileSync(file, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
  console.log(file);
}
