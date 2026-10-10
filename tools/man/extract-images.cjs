// GLB に埋め込まれた画像を取り出す（<出力の頭>_img<番号>.png）
// usage: node extract-images.cjs <in.glb> <出力の頭>
const fs = require('fs');
const path = require('path');
const [, , input, prefix] = process.argv;
const b = fs.readFileSync(input);
const jsonLen = b.readUInt32LE(12);
const j = JSON.parse(b.slice(20, 20 + jsonLen).toString());
const bin = b.slice(20 + jsonLen + 8);
fs.mkdirSync(path.dirname(prefix), { recursive: true });
j.images.forEach((im, i) => {
  const bv = j.bufferViews[im.bufferView];
  const start = bv.byteOffset || 0;
  fs.writeFileSync(`${prefix}_img${i}.png`, bin.slice(start, start + bv.byteLength));
  console.log(i, im.name, bv.byteLength);
});
