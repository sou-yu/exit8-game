import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// ビルド結果を1つのHTMLにまとめ、ダブルクリックでも遊べるようにする
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
});
