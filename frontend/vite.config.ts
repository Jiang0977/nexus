import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../frontend/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links']
        }
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://localhost:59000',
      '/ws': {
        target: 'ws://localhost:59000',
        ws: true,
      },
    },
  },
})
