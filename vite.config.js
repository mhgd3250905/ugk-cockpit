import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  root: 'web',
  plugins: [tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
  },
  build: {
    outDir: '../dist/web',
    // Vite empties the output directory at renderStart, before writing anything.
    // The workbench serves these files while it runs and the launchers build
    // before stopping it, so a build that fails halfway used to leave the live
    // console with no assets at all. Assets are content-hashed and index.html is
    // rewritten as a whole, so keeping the previous files is strictly safer than
    // clearing them; stale bundles only cost disk.
    emptyOutDir: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:41737',
      '/health': 'http://127.0.0.1:41737',
    },
  },
});
