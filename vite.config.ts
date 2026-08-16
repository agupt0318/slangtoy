import { defineConfig } from 'vite';

export default defineConfig({
  // Relative so the same build works at a domain root and under a project-pages
  // path like /slangtoy/. Absolute '/assets/...' 404s everywhere but the root.
  base: './',
  build: {
    target: 'esnext',
    rollupOptions: {
      // diff.html is the differential test harness; it ships with the site so
      // the comparison can be re-run against the deployed build.
      input: { main: 'index.html', diff: 'diff.html' },
    },
  },
});
