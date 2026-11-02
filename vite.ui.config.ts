// Builds the editor UI on its own (out/renderer), served by the Tauri desktop app and the
// Rust web server.
import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000
  }
})
