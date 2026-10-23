import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// ペンギンの動きの見本ページを 1 つの HTML にまとめる（出力は tools/penguin-viewer/dist）
export default defineConfig({
  root: 'tools/penguin-viewer',
  base: './',
  assetsInclude: ['**/*.glb'],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  plugins: [viteSingleFile()],
});
