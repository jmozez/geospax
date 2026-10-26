import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Tauri serves the built files; on Android the dev server must be reachable from the phone (TAURI_DEV_HOST).
export default defineConfig({
  clearScreen: false,
  // relative asset URLs (Tauri serves the build from its own origin); MapLibre 6's worker is an ES module
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: 'es' },
  server: { port: 5174, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  build: { target: 'es2021', chunkSizeWarningLimit: 1500 },
});
