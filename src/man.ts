import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as T from './textures';
import * as P from './pbr';

/*
 * 通行人（会社員の男性）。箱や球を組み合わせた人形に見えないよう、
 * 胴・腰・手足・頭は断面が少しずつ変わる曲面で作る。
 * 顔は頭の曲面全体に貼るテクスチャで描き、異変ではそのテクスチャを差し替える。
 */

export interface Man {
  group: THREE.Group;
  head: THREE.Object3D;
  faceMat: THREE.MeshStandardMaterial;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 点列 [y, 値] をなめらかにつなぐ（Catmull-Rom）。y は昇順 */
function profile(pts: [number, number][]) {
  return (y: number) => {
    if (y <= pts[0][0]) return pts[0][1];
    const n = pts.length;
    if (y >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0;
    while (y > pts[i + 1][0]) i++;
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    const t = (y - p1[0]) / (p2[0] - p1[0]);
    const h = p2[0] - p1[0];
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * h;
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
  };
}

type SurfFn = (u: number, v: number, out: THREE.Vector3) => THREE.Vector3;
type RefFn = (p: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3;

const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _du = new THREE.Vector3(), _n = new THREE.Vector3(), _r = new THREE.Vector3();

/**
 * パラメータ曲面 (u, v ∈ [0,1]) を三角形にする。法線は差分から求め、ref から離れる向きにそろえる
 * （つなぎ目でも同じ式から法線が出るので、継ぎ目の折れが見えない）。uv は (u, 1 - v)。
 */
function surface(fn: SurfFn, nu: number, nv: number, ref: RefFn): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const e = 1e-3;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      fn(u, v, _p);
      fn(Math.min(1, u + e), v, _a);
      fn(Math.max(0, u - e), v, _b);
      _du.subVectors(_a, _b);
      fn(u, Math.min(1, v + e), _a);
      fn(u, Math.max(0, v - e), _b);
      _a.sub(_b);
      _n.crossVectors(_du, _a);
      ref(_p, _r);
      _r.subVectors(_p, _r);
      if (_n.lengthSq() < 1e-16) _n.copy(_r);
      _n.normalize();
      if (_n.dot(_r) < 0) _n.negate();
      pos.push(_p.x, _p.y, _p.z);
      nor.push(_n.x, _n.y, _n.z);
      uv.push(u, 1 - v);
    }
  }
  const row = nu + 1;
  const P3 = (k: number) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row;
      // 対角線の外積で向きを決める（極で辺がつぶれた四角形でも安定）
      const x = P3(c).sub(P3(a)).cross(P3(d).sub(P3(b)));
      const nx = nor[a * 3] + nor[c * 3], ny = nor[a * 3 + 1] + nor[c * 3 + 1], nz = nor[a * 3 + 2] + nor[c * 3 + 2];
      if (x.x * nx + x.y * ny + x.z * nz >= 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const axisRef: RefFn = (p, out) => out.set(0, p.y, 0);
const originRef: RefFn = (_p2, out) => out.set(0, 0, 0);

// ================= 頭 =================

/** 頭の半径（m）: 幅・高さ・奥行き */
const HA = 0.076, HB = 0.109, HC = 0.098;

/** あごに向かって幅が細くなる割合（dy: 単位球での高さ -1..1） */
function jawK(dy: number) {
  // 頭頂側は丸く張り、あご側はすぼまる（卵を逆さにした形）
  return dy < 0 ? 1 - 0.17 * Math.pow(-dy, 1.6) : 1 + 0.12 * dy * (1 - dy);
}

/**
 * 頭の表面。theta: 頭頂から（0..π）、phi: three.js の球と同じ向き（π/2 が顔の正面 +z）。
 * 楕円体をもとに、あごを細く、顔の前面を平たく、あご先を少し前に出す。
 */
function headAt(theta: number, phi: number, out: THREE.Vector3) {
  const st = Math.sin(theta);
  const dx = -Math.cos(phi) * st, dy = Math.cos(theta), dz = Math.sin(phi) * st;
  const j = jawK(dy);
  const z = dz > 0
    ? (dz + 0.6 * dz * dz * (1 - dz)) * (1 + 0.14 * smooth(0.25, 0.85, -dy)) * HC
    : dz * HC * 1.03;
  return out.set(dx * HA * j, dy * HB, z);
}

/** 生え際の高さ（頭頂からの角度）。正面は額が見え、横・後ろは低い */
function hairline(phi: number) {
  const s = (1 - Math.cos(phi - Math.PI / 2)) / 2;
  return THREE.MathUtils.degToRad(48 + 24 * s + 40 * s * s);
}

const FACE_W = 1024, FACE_H = 512;
const faceCache = new Map<string, THREE.CanvasTexture>();

type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/**
 * 頭全体に貼るテクスチャ（u: 頭のまわり、v: 頭頂→あご）。顔の部品は実寸（m）で置く。
 * normal: ふだんの少し疲れた無表情 / smile: 目を見開いた不自然な笑顔（異変）
 */
export function faceTexture(kind: 'normal' | 'smile'): THREE.CanvasTexture {
  const hit = faceCache.get(kind);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = FACE_W;
  c.height = FACE_H;
  const g = c.getContext('2d')!;
  const SKIN: RGB = [197, 157, 132];
  g.fillStyle = rgba(SKIN, 1);
  g.fillRect(0, 0, FACE_W, FACE_H);

  /** 顔の正面から見た位置（x: 右が +、y: 上が +、頭の中心が原点、m）→ キャンバス座標 */
  const at = (x: number, y: number): [number, number] => {
    const dy = clamp(y / HB, -0.999, 0.999);
    const th = Math.acos(dy);
    const ph = Math.acos(clamp(-x / (Math.sin(th) * HA * jawK(dy)), -1, 1));
    return [((ph + Math.PI / 2) / (2 * Math.PI)) * FACE_W, (th / Math.PI) * FACE_H];
  };
  const path = (pts: [number, number][], close = true) => {
    g.beginPath();
    pts.forEach(([x, y], i) => {
      const [px, py] = at(x, y);
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    });
    if (close) g.closePath();
  };
  const fill = (pts: [number, number][], col: RGB, a = 1) => { path(pts); g.fillStyle = rgba(col, a); g.fill(); };
  const stroke = (pts: [number, number][], col: RGB, a: number, width: number) => {
    path(pts, false);
    g.strokeStyle = rgba(col, a);
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke();
  };
  /** やわらかい色むら（楕円のぼかし） */
  const spot = (x: number, y: number, rx: number, ry: number, col: RGB, a: number) => {
    const [px, py] = at(x, y);
    const rxp = Math.max(1, Math.abs(at(x + rx, y)[0] - px));
    const ryp = Math.max(1, Math.abs(at(x, y - ry)[1] - py));
    g.save();
    g.translate(px, py);
    g.scale(1, ryp / rxp);
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, rxp);
    grd.addColorStop(0, rgba(col, a));
    grd.addColorStop(1, rgba(col, 0));
    g.fillStyle = grd;
    g.fillRect(-rxp, -rxp, rxp * 2, rxp * 2);
    g.restore();
  };
  /** 中心 (cx, cy)、半径 (rx, ry) の楕円の点列（a0..a1） */
  const arc = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 24) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = a0 + ((a1 - a0) * i) / n;
      return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry] as [number, number];
    });
  const mirror = (pts: [number, number][]) => pts.map(([x, y]) => [-x, y] as [number, number]);
  const both = (f: (s: number) => void) => { f(1); f(-1); };

  // 肌の色むら: 額は明るく、頬は赤み、目のまわりは暗く、あごと口のまわりは青みがかった髭のそり跡
  spot(0, 0.052, 0.05, 0.025, [216, 172, 142], 0.35);
  both((s) => spot(0.042 * s, -0.026, 0.028, 0.022, [198, 126, 104], 0.28));
  both((s) => spot(0.031 * s, 0.006, 0.022, 0.012, [146, 102, 84], 0.38));
  both((s) => spot(0.012 * s, -0.004, 0.006, 0.02, [160, 114, 92], 0.25));
  spot(0, -0.08, 0.06, 0.038, [118, 108, 108], 0.24);
  spot(0, -0.043, 0.024, 0.008, [118, 106, 104], 0.22);
  both((s) => spot(0.05 * s, -0.06, 0.022, 0.03, [120, 108, 106], 0.16));

  const smile = kind === 'smile';
  const browLift = smile ? 0.006 : 0;
  // 眉
  both((s) => {
    const pts: [number, number][] = [
      [0.012, 0.0245], [0.02, 0.0285], [0.029, 0.0305], [0.039, 0.029], [0.048, 0.0245],
      [0.0485, 0.0222], [0.039, 0.0258], [0.029, 0.027], [0.02, 0.0252], [0.012, 0.019],
    ].map(([x, y]) => [x, y + browLift] as [number, number]);
    fill(s > 0 ? pts : mirror(pts), [43, 32, 25], 0.88);
  });

  // 目: 白目 → 虹彩 → 瞳 → まぶたの線と二重の線
  both((s) => {
    const ex = 0.031 * s, ey = 0.0045;
    const up = smile ? 0.0085 : 0.005, lo = smile ? 0.0075 : 0.004;
    const hw = 0.0125;
    const eye = [...arc(ex, ey, hw, up, Math.PI, 0, 20), ...arc(ex, ey, hw, lo, 0, -Math.PI, 20)]
      // 上下とも目尻側をわずかに下げる
      .map(([x, y]) => [x, y - 0.0012 * ((x - ex) * s / hw)] as [number, number]);
    g.save();
    fill(eye, [222, 212, 200], 1);
    g.clip();
    const ir = 0.0055;
    fill(arc(ex, ey + (smile ? 0 : 0.0006), ir, ir, 0, Math.PI * 2, 24), [62, 44, 33], 1);
    fill(arc(ex, ey + (smile ? 0 : 0.0006), ir * 0.42, ir * 0.42, 0, Math.PI * 2, 16), [18, 13, 11], 1);
    // 上まぶたの影
    spot(ex, ey + up, hw, 0.004, [90, 60, 48], smile ? 0.25 : 0.55);
    g.restore();
    stroke(eye.slice(0, 21), [52, 36, 28], 0.95, 3);
    stroke(arc(ex, ey + up * 0.2, hw * 1.02, up + 0.0045, Math.PI * 0.95, Math.PI * 0.05, 16), [140, 98, 80], 0.55, 2);
    stroke(eye.slice(21), [120, 84, 70], 0.4, 1.5);
  });

  // 鼻の下の影と小鼻（立体の鼻と合わせる）
  spot(0, -0.036, 0.016, 0.006, [150, 100, 82], 0.35);

  // 口
  if (!smile) {
    const upper: [number, number][] = [[-0.024, -0.0512], [-0.012, -0.0485], [-0.004, -0.0478], [0, -0.0484], [0.004, -0.0478], [0.012, -0.0485], [0.024, -0.0512],
      [0.012, -0.0514], [0, -0.0516], [-0.012, -0.0514]];
    const lower: [number, number][] = [[-0.022, -0.0515], [-0.011, -0.0518], [0, -0.0518], [0.011, -0.0518], [0.022, -0.0515],
      [0.014, -0.0566], [0, -0.0585], [-0.014, -0.0566]];
    fill(upper, [168, 102, 88], 0.75);
    fill(lower, [178, 112, 96], 0.65);
    spot(0, -0.0625, 0.014, 0.004, [140, 96, 80], 0.3);
    stroke([[-0.0245, -0.0518], [-0.012, -0.0515], [0, -0.0517], [0.012, -0.0515], [0.0245, -0.0518]], [80, 42, 34], 1, 2.5);
  } else {
    // 口角だけが不自然に高く上がった、歯の見える笑い
    const outer: [number, number][] = [];
    for (let i = 0; i <= 24; i++) {
      const t = -1 + (2 * i) / 24;
      outer.push([t * 0.037, -0.045 + 0.011 * Math.pow(Math.abs(t), 2.2) - 0.004 * (1 - t * t)]);
    }
    for (let i = 24; i >= 0; i--) {
      const t = -1 + (2 * i) / 24;
      outer.push([t * 0.037, -0.045 + 0.011 * Math.pow(Math.abs(t), 2.2) - 0.019 * (1 - t * t)]);
    }
    fill(outer, [58, 22, 20], 1);
    g.save();
    path(outer);
    g.clip();
    const teeth: [number, number][] = [];
    for (let i = 0; i <= 20; i++) {
      const t = -1 + (2 * i) / 20;
      teeth.push([t * 0.032, -0.046 + 0.011 * Math.pow(Math.abs(t), 2.2) - 0.003 * (1 - t * t)]);
    }
    for (let i = 20; i >= 0; i--) {
      const t = -1 + (2 * i) / 20;
      teeth.push([t * 0.032, -0.046 + 0.011 * Math.pow(Math.abs(t), 2.2) - 0.0105 * (1 - t * t)]);
    }
    fill(teeth, [226, 218, 198], 1);
    for (let k = -5; k <= 5; k++) {
      const x = k * 0.0055;
      const y0 = -0.046 + 0.011 * Math.pow(Math.abs(x / 0.032), 2.2);
      stroke([[x, y0], [x, y0 - 0.008]], [150, 140, 125], 0.6, 1);
    }
    g.restore();
    path(outer);
    g.strokeStyle = rgba([150, 86, 74], 0.9);
    g.lineWidth = 3;
    g.stroke();
    both((s) => spot(0.04 * s, -0.04, 0.008, 0.012, [150, 100, 84], 0.45)); // 頬の盛り上がりの影
  }

  // 髪（立体の髪の内側。縁からすき間が見えないよう少し広めに塗る）
  g.fillStyle = rgba([33, 26, 20], 1);
  for (let x = 0; x < FACE_W; x++) {
    const ph = ((x + 0.5) / FACE_W) * Math.PI * 2 - Math.PI / 2;
    let th = THREE.MathUtils.radToDeg(hairline(ph)) + 3;
    // 正面からの角度。もみあげは耳の前に少し下ろす
    const side = Math.abs(THREE.MathUtils.radToDeg(Math.atan2(Math.sin(ph - Math.PI / 2), Math.cos(ph - Math.PI / 2))));
    if (side > 64 && side < 80) th = Math.max(th, 96 - Math.abs(side - 72) * 1.2);
    g.fillRect(x, 0, 1, (th / 180) * FACE_H);
  }

  // 細かな肌理
  const img = g.getImageData(0, 0, FACE_W, FACE_H);
  let seed = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = ((seed >> 8) % 7) - 3;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  faceCache.set(kind, t);
  return t;
}

// ================= 体 =================

/** 胴（シャツ）: 幅・前後の厚みを高さごとに変えた楕円断面 */
const torsoW = profile([[0.9, 0.15], [1.0, 0.152], [1.1, 0.156], [1.22, 0.162], [1.31, 0.17], [1.365, 0.176], [1.395, 0.168], [1.43, 0.14], [1.46, 0.108], [1.48, 0.084], [1.5, 0.068]]);
const torsoF = profile([[0.9, 0.095], [1.0, 0.096], [1.1, 0.101], [1.2, 0.11], [1.3, 0.116], [1.38, 0.106], [1.44, 0.088], [1.48, 0.072], [1.5, 0.064]]);
const torsoB = profile([[0.9, 0.09], [1.0, 0.085], [1.1, 0.087], [1.2, 0.094], [1.3, 0.1], [1.4, 0.096], [1.45, 0.084], [1.48, 0.07], [1.5, 0.062]]);
/** 腰（ズボン） */
const hipW = profile([[0.78, 0.118], [0.82, 0.152], [0.88, 0.163], [0.94, 0.16], [0.985, 0.153]]);
const hipF = profile([[0.78, 0.07], [0.84, 0.094], [0.92, 0.1], [0.985, 0.098]]);
const hipB = profile([[0.78, 0.078], [0.85, 0.108], [0.92, 0.104], [0.985, 0.094]]);

function ring(w: (y: number) => number, f: (y: number) => number, b: (y: number) => number, y0: number, y1: number, grow = 0): SurfFn {
  return (u, v, out) => {
    const a = u * Math.PI * 2;
    const y = y0 + (y1 - y0) * v;
    const s = Math.sin(a);
    return out.set(Math.cos(a) * (w(y) + grow), y, s * ((s > 0 ? f(y) : b(y)) + grow));
  };
}

/** 手足（上端を丸く閉じた、太さの変わる筒）。y は付け根から下向きに負 */
function limb(r: (y: number) => number, top: number, bottom: number, sx = 1): SurfFn {
  return (u, v, out) => {
    const a = u * Math.PI * 2;
    const y = top + (bottom - top) * v;
    const rr = r(y);
    return out.set(Math.cos(a) * rr * sx, y, Math.sin(a) * rr);
  };
}

/** 足もとの柔らかい陰り（床に乗算で重ねる） */
let blobTex: THREE.Texture | null = null;
export function blob(size: number): THREE.Mesh {
  blobTex ??= T.blobTexture();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
    map: blobTex, blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true, depthWrite: false, toneMapped: false,
  }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.renderOrder = 1;
  return m;
}

export function buildMan(): Man {
  const g = new THREE.Group();
  const shirtSet = P.fabric(0xdfe5ec); // 白に近い淡い水色のワイシャツ
  const shirt = new THREE.MeshStandardMaterial({ ...shirtSet, roughness: 1 });
  const pants = new THREE.MeshStandardMaterial({ ...P.fabric(0x2e3138), roughness: 1 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc59d84, roughness: 0.55 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x211a14, roughness: 0.5 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x17140f, roughness: 0.32 });
  for (const m of [shirt, pants]) {
    for (const t of [m.map, m.normalMap, m.roughnessMap]) t?.repeat.set(10, 6);
  }

  // 胴・腰・ベルト
  g.add(new THREE.Mesh(surface(ring(torsoW, torsoF, torsoB, 0.9, 1.5), 40, 24, axisRef), shirt));
  g.add(new THREE.Mesh(surface(ring(hipW, hipF, hipB, 0.78, 0.985), 40, 10, axisRef), pants));
  const beltW = () => 0.163, beltF = () => 0.104, beltB = () => 0.1;
  g.add(new THREE.Mesh(surface(ring(beltW, beltF, beltB, 0.935, 0.972), 40, 2, axisRef), leather));

  // ネクタイ（胸の丸みに沿わせる）
  const tieW = profile([[1.1, 0.042], [1.14, 0.074], [1.42, 0.05], [1.445, 0.038], [1.462, 0.04], [1.48, 0.032]]);
  const tieTip = (x: number, y: number) => (y < 1.14 ? 1.1 + Math.abs(x) * 0.7 : y);
  const tie = surface((u, v, out) => {
    const y = 1.1 + 0.38 * v;
    const x = (u - 0.5) * tieW(y);
    const yy = Math.max(tieTip(x, y), y);
    return out.set(x, yy, torsoF(yy) + 0.004 + (yy > 1.44 ? 0.006 : 0));
  }, 6, 30, (p, out) => out.set(p.x, p.y, p.z - 1));
  g.add(new THREE.Mesh(tie, new THREE.MeshStandardMaterial({ color: 0x2f4362, roughness: 0.4 })));

  // 首と襟
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.061, 0.14, 20, 1, true), skin);
  neck.position.y = 1.535;
  g.add(neck);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.066, 0.012, 10, 32), shirt);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.478;
  collar.scale.set(1, 0.95, 1);
  g.add(collar);

  // 頭（顔のテクスチャを頭全体に貼る）、髪、耳、鼻
  const head = new THREE.Group();
  head.position.y = 1.64;
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTexture('normal'), roughness: 0.55 });
  const skull = surface((u, v, out) => headAt(Math.PI * v, -Math.PI / 2 + Math.PI * 2 * u, out), 56, 36, originRef);
  head.add(new THREE.Mesh(skull, faceMat));
  const hairGeo = surface((u, v, out) => {
    const phi = -Math.PI / 2 + Math.PI * 2 * u;
    headAt(v * hairline(phi), phi, out);
    return out.multiplyScalar(1.008 + 0.032 * (1 - v * v));
  }, 56, 14, originRef);
  head.add(new THREE.Mesh(hairGeo, hair));
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin);
    ear.scale.set(0.008, 0.028, 0.017);
    ear.position.set(s * (HA * jawK(-0.09) + 0.001), -0.01, -0.008);
    ear.rotation.y = s * 0.18;
    head.add(ear);
  }
  const noseBase = headAt(Math.acos(-0.017 / HB), Math.PI / 2, new THREE.Vector3());
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
  nose.scale.set(0.0102, 0.022, 0.0118);
  nose.rotation.x = -0.32;
  nose.position.set(0, -0.016, noseBase.z + 0.0035);
  head.add(nose);
  g.add(head);

  // 脚（ズボン）と靴
  const legR = profile([[-0.845, 0.068], [-0.82, 0.065], [-0.7, 0.064], [-0.42, 0.07], [-0.15, 0.079], [0, 0.083], [0.035, 0.06], [0.06, 0.001]]);
  const mkLeg = (x: number) => {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, 0.9, 0);
    pivot.add(new THREE.Mesh(surface(limb(legR, 0.06, -0.845, 0.92), 20, 24, axisRef), pants));
    const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.098, 0.075, 0.27, 3, 0.034), leather);
    shoe.position.set(0, -0.865, 0.04);
    pivot.add(shoe);
    g.add(pivot);
    return pivot;
  };
  const legL = mkLeg(-0.088);
  const legRt = mkLeg(0.088);

  // 腕（袖）と手
  const armR = profile([[-0.52, 0.035], [-0.49, 0.037], [-0.28, 0.045], [-0.12, 0.049], [0, 0.05], [0.025, 0.036], [0.04, 0.001]]);
  const mkArm = (x: number) => {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, 1.36, 0);
    pivot.rotation.z = Math.sign(x) * 0.05; // 腕はわずかに外へ開いて下がる
    pivot.add(new THREE.Mesh(surface(limb(armR, 0.04, -0.52), 18, 20, axisRef), shirt));
    // 肩の丸み（胴の肩の線より上に出ないよう、低くつぶす）
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.052, 18, 12), shirt);
    shoulder.scale.set(1, 0.66, 1.08);
    shoulder.position.set(x < 0 ? 0.008 : -0.008, 0, 0);
    pivot.add(shoulder);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skin);
    hand.scale.set(0.025, 0.07, 0.044);
    hand.position.y = -0.585;
    pivot.add(hand);
    g.add(pivot);
    return pivot;
  };
  const armL = mkArm(-0.198);
  const armRt = mkArm(0.198);
  const bag = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.28, 0.38, 2, 0.02), new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.35 }));
  bag.position.set(0.012, -0.76, 0);
  armRt.add(bag);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.007, 8, 16, Math.PI), leather);
  handle.rotation.y = Math.PI / 2;
  handle.position.set(0.012, -0.62, 0);
  armRt.add(handle);

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.add(blob(0.9));
  return { group: g, head, faceMat, legL, legR: legRt, armL, armR: armRt };
}

/** 黒い人影（異変） */
export function buildShadow(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x030303 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.4, 6, 12), mat);
  body.scale.set(1, 1, 0.7);
  body.position.y = 0.92;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat);
  head.position.y = 1.86;
  g.add(head);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  g.add(blob(0.9));
  g.visible = false;
  return g;
}
