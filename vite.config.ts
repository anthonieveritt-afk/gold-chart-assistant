import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 800, rollupOptions: { input: { main: 'index.html', paper: 'paper.html' } } },
});
