/**
 * _check.mjs — syntax-check probe sources without a browser.
 *   node tools/probes/_check.mjs
 *
 * A probe is not a module: the daemon wraps its source in an async function and
 * it ends in a bare `return`, so `node --check` on the file itself always fails
 * with "Illegal return statement" and tells you nothing. That is exactly how a
 * probe with a syntax error reaches the queue, waits behind eight other authors
 * for four minutes and then reports a parse error. This wraps each probe the way
 * the daemon does and parses it — in milliseconds, offline.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(DIR)).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort();

let bad = 0;
for (const f of files) {
  const src = await readFile(path.join(DIR, f), 'utf8');
  try {
    // Same wrapper the daemon builds in handleEval().
    new Function('g', 'THREE', 'ARGS', `return (async () => {\n${src}\n})();`);
    console.log(`ok    ${f}`);
  } catch (err) {
    bad++;
    console.error(`FAIL  ${f}: ${err.message}`);
  }
}
process.exit(bad ? 1 : 0);
