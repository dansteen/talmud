import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020',
  },
  // PDF.js worker needs to be served as a separate file
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
