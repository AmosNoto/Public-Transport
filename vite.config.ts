import { defineConfig } from 'vite';

const api = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'client',
  publicDir: false,
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
