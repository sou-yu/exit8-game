import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import penguinGlb from './assets/penguin.glb?inline';

/*
 * 異変「ペンギンの足跡」の後半: 通路の奥からコウテイペンギンの群れが走ってくる。
 * モデルは Blender で作った src/assets/penguin.glb（身長 約 1.1m、+z が正面。作業ファイルは 8番出口/blender/penguin/penguin.blend）。
 * 体・くちばしと尾・左右の翼・左右の足の 6 つの部品に分かれていて、部品ごとに InstancedMesh で群れ全体をまとめて描く。
 * 走る動き（前かがみで左右に体を揺らし、翼を横へ広げてばたつかせ、短い足でちょこちょこ進む）はここで付ける。
 * 体の模様（黒い頭、耳の黄色、胸の淡い黄色、白い腹と黒い背中の境の筋、羽毛のむら）はキャンバスに描いて UV で貼る。
 */

/** 群れの数 */
export const PENGUIN_COUNT = 24;

type Part = 'Body' | 'Beak' | 'FlipperL' | 'FlipperR' | 'FootL' | 'FootR';
const PARTS: Part[] = ['Body', 'Beak', 'FlipperL', 'FlipperR', 'FootL', 'FootR'];

export interface PenguinPose {
  x: number;
  z: number;
  /** 進む向き（+z が 0） */
  yaw: number;
  /** 大きさの倍率 */
  scale: number;
  /** 走る動きの位相（1 周で左右 1 歩ずつ） */
  phase: number;
  /** 走る動きの強さ 0..1 */
  run: number;
}

export interface Penguins {
  /** 普段は非表示 */
  group: THREE.Group;
  /** 各ペンギンの姿勢を描く形に移す */
  update(poses: PenguinPose[]): void;
}

const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 体の模様。横は体を一周する角度（左端が正面）、縦は高さ（上が頭のてっぺん 1.12m）。glTF の UV に合わせて上下は反転しない */
function bodyTexture(): THREE.CanvasTexture {
  const NW = 512, NH = 512;
  const c = document.createElement('canvas');
  c.width = NW;
  c.height = NH;
  const g = c.getContext('2d')!;
  const id = g.createImageData(NW, NH);
  const BLACK: RGB = [12, 12, 14], BACK: RGB = [46, 50, 60], WHITE: RGB = [234, 232, 226];
  const CHEST: RGB = [246, 222, 150], EAR: RGB = [250, 172, 34], LINE: RGB = [16, 16, 18];
  // 羽毛のむら: 小さなうろこ状の明暗（縦に少し長い）
  const fe = new Float32Array(NW * NH);
  for (let k = 0; k < 14000; k++) {
    const x = Math.random() * NW, y = Math.random() * NH, r = 1.5 + Math.random() * 2, v = (Math.random() - 0.5) * 0.07;
    for (let dy = -r * 1.6; dy <= r * 1.6; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const q = (dx / r) ** 2 + (dy / (r * 1.6)) ** 2;
        if (q > 1) continue;
        const px = ((Math.round(x + dx) % NW) + NW) % NW, py = Math.round(y + dy);
        if (py < 0 || py >= NH) continue;
        fe[py * NW + px] += v * (1 - q);
      }
    }
  }
  for (let py = 0; py < NH; py++) {
    const z = (1 - (py + 0.5) / NH) * 1.12;
    for (let px = 0; px < NW; px++) {
      let a = ((px + 0.5) / NW) * Math.PI * 2;
      if (a > Math.PI) a -= Math.PI * 2;
      const aa = Math.abs(a);
      // 腹の白: 正面から左右に約 80 度。下ほど細く、首から上はなし
      const half = THREE.MathUtils.degToRad(80) * (1 - smooth(0.8, 0.88, z)) * (0.7 + 0.3 * smooth(0, 0.25, z));
      const w = 1 - smooth(half - 0.06, half + 0.015, aa);
      let col = mix(BACK, WHITE, w);
      // 白と背中の境の黒い筋
      const edge = Math.exp(-(((aa - (half + 0.05)) / 0.035) ** 2)) * (1 - smooth(0.76, 0.86, z));
      col = mix(col, LINE, 0.9 * edge);
      col = mix(col, CHEST, 0.85 * smooth(0.58, 0.8, z) * w);
      // 腹の下のほうは少しくすむ
      col = mix(col, [190, 186, 176], 0.35 * (1 - smooth(0.05, 0.3, z)) * w);
      col = mix(col, mix(BACK, BLACK, 0.6), 0.6 * smooth(0.55, 0.85, z) * (1 - w));
      col = mix(col, BLACK, smooth(0.81, 0.86, z));
      // 耳の模様: 頭の横に涙形。下の端が首の前へ細く伸びて胸の黄色とつながる
      const zc = 0.95 - 0.09 * smooth(1.5, 0.7, aa);
      const ac = 1.5 - 0.75 * smooth(0.95, 0.86, z);
      const ear = Math.max(
        Math.exp(-(((aa - ac) / 0.26) ** 4)) * Math.exp(-(((z - zc) / 0.032) ** 4)),
        Math.exp(-(((aa - 1.45) / 0.32) ** 4)) * Math.exp(-(((z - 0.955) / 0.034) ** 4)),
      );
      col = mix(col, EAR, Math.min(1, ear));
      const n = 1 + fe[py * NW + px] * (1 - 0.5 * w);
      const i = (py * NW + px) * 4;
      id.data[i] = Math.min(255, col[0] * n);
      id.data[i + 1] = Math.min(255, col[1] * n);
      id.data[i + 2] = Math.min(255, col[2] * n);
      id.data[i + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export async function loadPenguins(): Promise<Penguins> {
  const data = await (await fetch(penguinGlb)).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(data, '');
  const bodyMat = new THREE.MeshStandardMaterial({ map: bodyTexture(), roughness: 0.55, metalness: 0 });
  const partMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  const group = new THREE.Group();
  const meshes = new Map<Part, THREE.InstancedMesh>();
  /** 部品の付け根（体の原点から見た位置と向き） */
  const base = new Map<Part, THREE.Matrix4>();
  for (const p of PARTS) {
    const node = gltf.scene.getObjectByName(p) as THREE.Mesh;
    node.updateMatrix();
    base.set(p, node.matrix.clone());
    const im = new THREE.InstancedMesh(node.geometry, p === 'Body' ? bodyMat : partMat, PENGUIN_COUNT);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = p === 'Body';
    im.receiveShadow = true;
    group.add(im);
    meshes.set(p, im);
  }
  group.visible = false;

  const bodyM = new THREE.Matrix4(), tmp = new THREE.Matrix4(), out = new THREE.Matrix4();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  return {
    group,
    update(poses) {
      for (let i = 0; i < PENGUIN_COUNT; i++) {
        const p = poses[i];
        if (!p) {
          PARTS.forEach((n) => meshes.get(n)!.setMatrixAt(i, zero));
          continue;
        }
        const ph = p.phase, r = p.run;
        // 体: 前かがみ、1 歩ごとに左右へ傾き（よちよち）、少し弾む
        e.set(0.15 * r + 0.02 * Math.sin(ph * 2) * r, 0.1 * Math.sin(ph) * r + p.yaw, 0.16 * Math.sin(ph) * r, 'YXZ');
        q.setFromEuler(e);
        v.set(p.x, 0.03 * Math.abs(Math.sin(ph)) * r, p.z);
        bodyM.compose(v, q, s.setScalar(p.scale));
        for (const n of PARTS) {
          const b = base.get(n)!;
          if (n === 'Body' || n === 'Beak') {
            out.multiplyMatrices(bodyM, b);
          } else if (n === 'FlipperL' || n === 'FlipperR') {
            // 翼は横へ広げて、速くばたつかせる
            const side = n === 'FlipperR' ? 1 : -1;
            const flap = (0.45 + 0.22 * Math.sin(ph * 2 + side * 0.6)) * r;
            tmp.makeRotationFromEuler(e.set(0.35 * r, 0, side * flap, 'XYZ'));
            out.multiplyMatrices(bodyM, b).multiply(tmp);
          } else {
            // 足は左右交互に前後し、前へ出すときに少し上がる
            const side = n === 'FootR' ? 0 : Math.PI;
            const sw = Math.sin(ph + side);
            tmp.makeTranslation(0, 0.025 * Math.max(0, Math.cos(ph + side)) * r, 0.06 * sw * r);
            out.multiplyMatrices(bodyM, tmp).multiply(b);
          }
          meshes.get(n)!.setMatrixAt(i, out);
        }
      }
      meshes.forEach((m) => { m.instanceMatrix.needsUpdate = true; });
    },
  };
}
