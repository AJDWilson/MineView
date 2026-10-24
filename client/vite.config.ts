import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [path.resolve(root, '..')],
    },
    proxy: {
      '/api': 'http://127.0.0.1:3847',
      '/ws': { target: 'ws://127.0.0.1:3847', ws: true },
    },
  },
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
  },
});
