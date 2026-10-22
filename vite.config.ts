import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './ui/src'),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err: any) => {
            if (err?.code === 'ECONNRESET' || err?.message?.includes('ECONNRESET')) return;
            console.error('[vite] ws proxy error:', err);
          });
          proxy.on('open', (proxySocket: any) => {
            proxySocket.on('error', (err: any) => {
              if (err?.code === 'ECONNRESET' || err?.message?.includes('ECONNRESET')) return;
              console.error('[vite] ws proxy socket error:', err);
            });
          });
        },
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
