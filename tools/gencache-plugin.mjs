/**
 * gencache-plugin — a vite dev middleware that lets the page persist expensive
 * generated data to disk and get it back on the next load.
 *
 * WHY. A world build is 25.7 s, of which 11.6 s is the terrain heightfield and
 * its hydraulic erosion sim. That sim is deterministic: same source, same
 * parameters, same bytes out. Re-running it on every page load is the single
 * largest cost in this project's inner loop, and it is pure waste — with seven
 * agents it was most of the wall clock.
 *
 * The cache is keyed by the caller (which passes a hash of the source that
 * generates the data), so it invalidates exactly when the generator changes and
 * never when something unrelated does. Editing a shader must not re-run erosion.
 *
 *   GET  /__gencache/<key>   -> 200 with the bytes, or 404
 *   PUT  /__gencache/<key>   -> stores the body
 *
 * Dev-only, and scoped to a cache dir under the tree. Never wire this into a
 * production build.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, createReadStream, createWriteStream, existsSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export function gencache({ dir = 'node_modules/.gencache' } = {}) {
  const root = path.resolve(dir);
  mkdirSync(root, { recursive: true });

  const fileFor = (key) =>
    path.join(root, createHash('sha1').update(String(key)).digest('hex') + '.bin');

  return {
    name: 'gencache',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__gencache/', (req, res, next) => {
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
          return createReadStream(file).pipe(res);
        }

        if (req.method === 'PUT') {
          let seen = 0;
          const out = createWriteStream(file + '.tmp');
          req.on('data', (c) => {
            seen += c.length;
            if (seen > MAX_ENTRY_BYTES) {
              req.destroy();
              out.destroy();
            }
          });
          req.pipe(out);
          out.on('finish', () => {
            try {
              // Rename last so a crashed write can never be read as valid.
              renameSync(file + '.tmp', file);
            } catch {
              /* best effort — a miss just costs a regeneration */
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

        next();
      });
    },
  };
}
