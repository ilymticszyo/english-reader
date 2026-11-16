import { defineConfig } from 'vite';

// Relative base by default so the build works on any static host / sub-path.
// Override for a fixed sub-path: BASE_PATH=/english-reader/ npm run build
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  build: { target: 'es2022', sourcemap: false },
  server: { host: true },
  preview: { host: true },
});
