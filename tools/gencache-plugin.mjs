/**
 * gencache-plugin — a vite middleware that lets the page persist expensive
 * generated data to disk and get it back on the next load.
 *
 * WHY. A world build is 25.7 s in dev / 16.0 s from a bundle, and 11.6 s of that
 * is the terrain heightfield and its hydraulic erosion sim. That sim is
 * deterministic: same source, same parameters, same bytes out. Re-running it on
 * every page load is the single largest remaining cost in this project's inner
 * loop, and with several agents iterating in parallel it was most of the wall
 * clock.
 *
 * The cache is keyed by the caller, which passes a version it bumps when its
 * generator changes — so it invalidates exactly when the maths does, and never
 * when an unrelated file moves. Editing a shader must not re-run erosion.
 *
 *   GET  /__gencache/<key>   -> 200 with the bytes, or 404
 *   PUT  /__gencache/<key>   -> stores the body
 *
 * Mounted on BOTH the dev server and the preview server: the render daemon
 * serves a production bundle via `vite preview`, so a dev-only middleware would
 * make every load a miss.
 *
 * Dev/preview tooling only — never wire this into a deployed build.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
  renameSync,
  readdirSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
// A baked terrain is 214 MB and its key changes with every edit to Terrain.js,
// so an unbounded cache grows by a fifth of a gigabyte per iteration and never
// shrinks. Evict by age, and by total size worst-first, on every start.
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

function sweep(root) {
  let entries = [];
  try {
    entries = readdirSync(root)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => {
        const full = path.join(root, f);
        const st = statSync(full);
        return { full, size: st.size, atime: st.atimeMs };
      });
  } catch {
    return;
  }
  const now = Date.now();
  let total = 0;
  for (const e of entries) {
    if (now - e.atime > TTL_MS) {
      try { unlinkSync(e.full); } catch {}
      e.dead = true;
    } else total += e.size;
  }
  // Still too big: drop least-recently-used until under the cap.
  const live = entries.filter((e) => !e.dead).sort((a, b) => a.atime - b.atime);
  for (const e of live) {
    if (total <= MAX_TOTAL_BYTES) break;
    try { unlinkSync(e.full); total -= e.size; } catch {}
  }
}

export function gencache({ dir = 'node_modules/.gencache' } = {}) {
  const root = path.resolve(dir);
  mkdirSync(root, { recursive: true });
  sweep(root);

  const fileFor = (key) =>
    path.join(root, createHash('sha1').update(String(key)).digest('hex') + '.bin');

  function handler(req, res, next) {
    const key = decodeURIComponent((req.url || '').replace(/^\//, '').split('?')[0]);
    if (!key) return next();
    const file = fileFor(key);

    if (req.method === 'GET') {
      if (!existsSync(file)) {
        res.statusCode = 404;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', statSync(file).size);
      try { const n = new Date(); utimesSync(file, n, statSync(file).mtime); } catch {}
      return createReadStream(file).pipe(res);
    }

    if (req.method === 'PUT') {
      let seen = 0;
      const tmp = `${file}.${process.pid}.tmp`;
      const out = createWriteStream(tmp);
      req.on('data', (c) => {
        seen += c.length;
        if (seen > MAX_ENTRY_BYTES) {
          req.destroy();
          out.destroy();
        }
      });
      req.pipe(out);
      out.on('finish', () => {
        // Rename last, so a torn write can never be read back as valid.
        try {
          renameSync(tmp, file);
        } catch {
          /* best effort — a miss only costs a regeneration */
        }
        res.statusCode = 204;
        res.end();
      });
      out.on('error', () => {
        res.statusCode = 500;
        res.end();
      });
      return;
    }

    return next();
  }

  return {
    name: 'gencache',
    configureServer(server) {
      server.middlewares.use('/__gencache/', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__gencache/', handler);
    },
  };
}
