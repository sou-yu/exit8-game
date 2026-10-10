import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// ビルド結果を1つのHTMLにまとめ、ダブルクリックでも遊べるようにする
export default defineConfig({
  base: './',
  // 通行人のモデル（.glb）も画像と同じく素材として扱い、HTML に埋め込む
  assetsInclude: ['**/*.glb'],
  plugins: [viteSingleFile()],
});
