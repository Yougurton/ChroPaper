import { defineConfig } from 'vite';

// Wallpaper Engine loads index.html straight off disk / its own local file server,
// so every asset must resolve with a relative path — hence base: './'.
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
  },
  worker: {
    format: 'es',
  },
});
