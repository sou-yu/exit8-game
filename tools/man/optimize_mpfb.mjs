// リアル版の通行人（blender/salaryman_mpfb/out/salaryman_game.glb）をゲーム用に軽くする
// usage: node optimize_mpfb.mjs <salaryman_game.glb> <出力.glb>
//  - 服・歯の細かすぎる形状を間引く（顔・目・鞄・スマホはそのまま）
//  - アニメーションのキーを間引き、時刻を 0 始まりにそろえる
//  - 量子化と meshopt 圧縮
// 笑顔用の顔画像（skin_smile）は元の GLB に入っているので、そのまま残す
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, quantize, meshopt, resample, prune, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const [, , input, out] = process.argv;
await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();

// 笑顔の顔画像はどの材料からも使われていないので、prune で消えないよう取っておいて最後に戻す
const smileTex = root.listTextures().find((t) => t.getName() === 'skin_smile');
const smileImg = smileTex.getImage(); const smileMime = smileTex.getMimeType();
await doc.transform(weld());
const ratios = { ShirtPants: 0.5, Teeth: 0.35 };
const tris = (p) => (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
let before = 0, after = 0;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const name = p.getMaterial()?.getName();
  before += tris(p);
  // モーフ（笑顔など）を持つ形は間引くと崩れるので、歯は形の変化だけ一緒に間引けるときに限る
  if (ratios[name] && p.listTargets().length === 0) {
    const t0 = tris(p);
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: ratios[name], error: 0.001, lockBorder: true });
    console.log('simplify', name, t0, '->', tris(p));
  }
  after += tris(p);
}
console.log('triangles', before, '->', after);

const shifted = new Set();
for (const a of root.listAnimations()) for (const s of a.listSamplers()) {
  const inp = s.getInput();
  if (shifted.has(inp)) continue;
  shifted.add(inp);
  const arr = inp.getArray(); const t0 = arr[0];
  for (let i = 0; i < arr.length; i++) arr[i] = Math.round((arr[i] - t0) * 1e6) / 1e6;
  inp.setArray(arr);
}
await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune());
if (!root.listTextures().some((t) => t.getName() === 'skin_smile')) doc.createTexture('skin_smile').setImage(smileImg).setMimeType(smileMime);
for (const a of root.listAnimations()) console.log('anim', a.getName(), 'dur', a.listSamplers()[0].getInput().getMax([])[0]);

await doc.transform(
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8, quantizeWeight: 8 }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' }),
);
await io.write(out, doc);
console.log('written', out, fs.statSync(out).size);
