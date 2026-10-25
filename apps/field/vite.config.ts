import { defineConfig } from 'vite';

// Tauri serves the built files; on Android the dev server must be reachable from the phone (TAURI_DEV_HOST).
export default defineConfig({
  clearScreen: false,
  // relative asset URLs (Tauri serves the build from its own origin); MapLibre 6's worker is an ES module
  base: './',
  worker: { format: 'es' },
  server: { port: 5174, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  build: { target: 'es2021', chunkSizeWarningLimit: 1500 },
});
