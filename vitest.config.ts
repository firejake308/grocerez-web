import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // server/ is a standalone package (own deps, own lockfile, own
    // vitest.config.ts) and is tested with `npm test` from inside it.
    exclude: ['**/node_modules/**', 'server/**'],
  },
});
