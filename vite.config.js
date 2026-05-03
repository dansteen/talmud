import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  build: {
    target: 'es2020',
  },
  // PDF.js worker needs to be served as a separate file
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  // Copy PDF.js font data and cMaps so non-embedded fonts render correctly
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts' },
        { src: 'node_modules/pdfjs-dist/cmaps/*',          dest: 'pdfjs/cmaps' },
      ],
    }),
  ],
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
