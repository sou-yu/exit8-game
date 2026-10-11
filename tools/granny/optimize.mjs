// おばあさんの GLB をゲーム用に軽くする（形はそのまま、量子化と meshopt 圧縮、アニメーションのキーを間引く）
// usage: node tools/granny/optimize.mjs <udon_granny.glb> src/assets/granny.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { quantize, meshopt, resample, prune, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const [, , input, out] = process.argv;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
await doc.transform(resample(), dedup(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(out, doc);
