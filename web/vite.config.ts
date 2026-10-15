import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: the same build is served by Axum (web) and embedded by Tauri (desktop).
  base: './',
  // MapLibre GL JS 6 is ESM-only and starts its worker as a module worker.
  worker: { format: 'es' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080', '/tiles': 'http://127.0.0.1:8080' },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
