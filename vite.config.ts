import { defineConfig } from 'vite';

export default defineConfig({
  // Relative so the same build works at a domain root and under a project-pages
  // path like /slangtoy/. Absolute '/assets/...' 404s everywhere but the root.
  base: './',
  build: {
    target: 'esnext',
  },
});
