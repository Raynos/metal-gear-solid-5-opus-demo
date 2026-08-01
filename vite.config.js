import { gencache } from './tools/gencache-plugin.mjs';

export default {
  plugins: [gencache()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
};
