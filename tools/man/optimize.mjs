// 通行人の GLB をゲーム用に軽くする
// usage: node optimize.mjs <office_man_rigged.glb> <出力.glb> <textures.py の出力フォルダ>
//  - 画像を JPEG に、手・服・金具の細かすぎる形状を間引く
//  - 歩行・待機のキー（30fps の STEP）を LINEAR にして時刻を 0 始まりにそろえる
//  - 笑顔用の顔画像を同じファイルに追加する（名前 head_smile）
//  - 量子化と meshopt 圧縮
import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, quantize, meshopt, resample, prune, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const [, , input, out, jpgDir] = process.argv;
await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();

// 画像の差し替え
const imgByName = {
  briefcase_leather_normal: 'bag_normal.jpg', briefcase_leather_albedo: 'bag_albedo.jpg',
  anatomical_head_albedo_neck: 'head.jpg',
};
for (const t of root.listTextures()) {
  let f = imgByName[t.getName()];
  if (!f && t.getName().startsWith('codex-clipboard-f3a7')) f = 'cloth.jpg';
  if (!f && t.getName().startsWith('codex-clipboard-4ff4')) f = 'teeth.jpg';
  if (!f) throw new Error('unknown texture ' + t.getName());
  t.setImage(fs.readFileSync(`${jpgDir}/${f}`)).setMimeType('image/jpeg').setURI('');
}

// 使わない UV（TEXCOORD_1）を外し、歯の UV（TEXCOORD_2）を 1 番に詰める
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  p.setAttribute('TEXCOORD_1', null);
  const uv2 = p.getAttribute('TEXCOORD_2');
  if (uv2) { p.setAttribute('TEXCOORD_2', null); p.setAttribute('TEXCOORD_1', uv2); }
}
for (const m of root.listMaterials()) {
  const ti = m.getBaseColorTextureInfo();
  if (m.getBaseColorTexture() && ti.getTexCoord() === 2) ti.setTexCoord(1);
}

await doc.transform(weld());

// 細かすぎる部分を間引く（顔・目・口・歯は元のまま）
const ratios = {
  'Skin | hands': 0.14,
  'Charcoal trousers | reference cloth': 0.4,
  'Cotton shirt | reference folds': 0.55,
  'Briefcase | subdued nickel fittings': 0.3,
};
let before = 0, after = 0;
const tris = (p) => (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const name = p.getMaterial()?.getName();
  before += tris(p);
  if (ratios[name]) {
    const t0 = tris(p);
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: ratios[name], error: 0.0012, lockBorder: true });
    console.log('simplify', name, t0, '->', tris(p));
  }
  after += tris(p);
}
console.log('triangles', before, '->', after);

// アニメーション：STEP → LINEAR、時刻を 0 始まりに（最後のキーは最初と同じ姿勢なので 1 秒できれいにつながる）
const shifted = new Set();
for (const a of root.listAnimations()) for (const s of a.listSamplers()) {
  if (s.getInterpolation() === 'STEP') s.setInterpolation('LINEAR');
  const inp = s.getInput();
  if (shifted.has(inp)) continue;
  shifted.add(inp);
  const arr = inp.getArray();
  const t0 = arr[0];
  for (let i = 0; i < arr.length; i++) arr[i] = Math.round((arr[i] - t0) * 1e6) / 1e6;
  inp.setArray(arr);
}
for (const a of root.listAnimations()) {
  const s0 = a.listSamplers()[0].getInput();
  console.log('anim', a.getName(), 'keys', s0.getCount(), 'dur', s0.getMax([])[0]);
}
await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune());

// 笑顔の顔画像（どのマテリアルにも付けず、ゲーム側で名前から取り出して差し替える）
doc.createTexture('head_smile').setImage(fs.readFileSync(`${jpgDir}/head_smile.jpg`)).setMimeType('image/jpeg');

await doc.transform(
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8, quantizeWeight: 8 }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' }),
);
await io.write(out, doc);
console.log('written', out, fs.statSync(out).size);
