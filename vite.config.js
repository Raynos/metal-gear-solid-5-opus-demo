import { gencache } from './tools/gencache-plugin.mjs';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Worktrees share one node_modules by symlink, so vite's default cache
// (node_modules/.vite) is shared too — seven agents building at once corrupted
// each other and produced pages that loaded but never became ready. Keep the
// cache inside the tree.
const terrainHash = createHash('sha1')
  .update(readFileSync(new URL('./src/world/Terrain.js', import.meta.url)))
  .digest('hex')
  .slice(0, 12);

export default {
  cacheDir: '.vite-cache',
  // The generation cache is keyed by this, so editing Terrain.js invalidates the
  // baked simulation automatically instead of silently reusing another tree's.
  define: { __TERRAIN_HASH__: JSON.stringify(terrainHash) },
  plugins: [gencache()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
};
