import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(root, '.') } },
  optimizeDeps: { entries: ['index.html'] },
  build: { outDir: 'dist-web', emptyOutDir: true, sourcemap: false },
  server: {
    port: 3002,
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
});
