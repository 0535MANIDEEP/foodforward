import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so the built bundle works from a GitHub Pages project path
  // without a rebuild for a different owner. Absolute '/' silently 404s every
  // asset the moment the site is served from /repository/.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Dev only. The built app talks to the deployed API via VITE_API_URL, so
      // nothing here affects production.
      '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
