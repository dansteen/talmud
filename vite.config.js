import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2020',
  },
  // PDF.js worker needs to be served as a separate file
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  // Mirror Netlify's /shas-api proxy in dev so the same URL works locally
  server: {
    proxy: {
      '/shas-api': {
        target: 'https://www.shas.org',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/shas-api/, '/daf-pdf/api'),
      },
    },
  },
});
