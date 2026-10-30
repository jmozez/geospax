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
  // two pages: the app and its help (help.html, the guides as a web page)
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, rollupOptions: { input: { main: 'index.html', help: 'help.html', layout: 'layout.html' },
    // Split the big third-party libraries into their own long-cached chunks so an app update
    // only re-downloads GeoSpaX code, and the browser fetches the pieces in parallel.
    output: { manualChunks(id: string) {
      if (!id.includes('node_modules')) return undefined;
      if (id.includes('maplibre-gl')) return 'vendor-maplibre';
      if (id.includes('@deck.gl') || id.includes('@luma.gl') || id.includes('@math.gl') || id.includes('@loaders.gl')) return 'vendor-deckgl';
      if (id.includes('apache-arrow') || id.includes('flatbuffers')) return 'vendor-arrow';
      if (id.includes('terra-draw')) return 'vendor-draw';
      if (id.includes('proj4') || id.includes('mgrs') || id.includes('wkt-parser')) return 'vendor-proj';
      return 'vendor';
    } } } },
});
