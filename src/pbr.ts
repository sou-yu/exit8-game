import * as THREE from 'three';

/*
 * 材質の細かな模様（カラー・法線・粗さ）を手続き的に生成する。外部画像は使わない。
 * - 実寸（mm）で高さを作り、そこから法線を求める（目地の深さ・面取りが実際の寸法になる）
 * - 1枚の周期は 1m（またはその約数）。ループの変換で世界座標が整数mずれても模様がそろう
 * - 床と天井は 180度回転しても同じ模様になる（点対称）ように作る
 * 大きな汚れ・色むら・陰りは bake.ts で別の UV（uv1）に焼き込む。
 */

let maxAniso = 8;
export function setMaxAnisotropy(n: number) { maxAniso = n; }

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

export interface Px {
  r: number; g: number; b: number; // sRGB 0..1
  h: number; // 高さ mm
  rough: number; // 0..1
}

// ---- ノイズ ----
export function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1440670441);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, px: number, py: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash(x0, y0, s), b = hash(x1, y0, s), c = hash(x0, y1, s), d = hash(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** 周期的な fBm。u,v は 0..1、fu,fv は基本周波数（整数） */
export function fbm(u: number, v: number, fu: number, fv: number, seed: number, oct = 4): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(u * fu * f, v * fv * f, fu * f, fv * f, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** 世界座標用の（周期を意識しない）fBm。x,y は m、scale は 1 周期の長さ m */
export function wfbm(x: number, y: number, scale: number, seed: number, oct = 4): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1 / scale;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * f + 913.7, y * f + 371.3, 65536, 65536, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** 点対称（u,v）→（1-u,1-v）にした fBm */
function sfbm(u: number, v: number, fu: number, fv: number, seed: number, oct = 4) {
  return 0.5 * (fbm(u, v, fu, fv, seed, oct) + fbm(1 - u, 1 - v, fu, fv, seed, oct));
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function hex(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

// ---- テクスチャ化 ----
export function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean, repeat = true): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

interface BuildOpts {
  w: number;
  h: number;
  /** テクスチャ1周期の実寸 mm（法線の傾きを実寸で求める） */
  mmU: number;
  mmV: number;
  fn: (u: number, v: number) => Px;
}

/** 1画素ごとの関数から カラー・法線・粗さ を作る */
export function build(o: BuildOpts): PBRSet {
  const { w, h } = o;
  const n = w * h;
  const col = new Uint8Array(n * 4);
  const rough = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const s = o.fn((x + 0.5) / w, v);
      const i = y * w + x;
      col[i * 4] = clamp01(s.r) * 255 + 0.5;
      col[i * 4 + 1] = clamp01(s.g) * 255 + 0.5;
      col[i * 4 + 2] = clamp01(s.b) * 255 + 0.5;
      col[i * 4 + 3] = 255;
      const r = clamp01(s.rough) * 255 + 0.5;
      rough[i * 4] = r; rough[i * 4 + 1] = r; rough[i * 4 + 2] = r; rough[i * 4 + 3] = 255;
      height[i] = s.h;
    }
  }
  const nor = new Uint8Array(n * 4);
  const du = o.mmU / w, dv = o.mmV / h;
  const Hh = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dhdu = (Hh(x + 1, y) - Hh(x - 1, y)) / (2 * du);
      const dhdv = (Hh(x, y + 1) - Hh(x, y - 1)) / (2 * dv);
      let nx = -dhdu, ny = -dhdv, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      nor[i] = (nx * 0.5 + 0.5) * 255 + 0.5;
      nor[i + 1] = (ny * 0.5 + 0.5) * 255 + 0.5;
      nor[i + 2] = (nz * 0.5 + 0.5) * 255 + 0.5;
      nor[i + 3] = 255;
    }
  }
  return {
    map: dataTexture(col, w, h, true),
    normalMap: dataTexture(nor, w, h, false),
    roughnessMap: dataTexture(rough, w, h, false),
  };
}

/** 目地からの距離 e(mm) に対する、目地の溝と角の丸み（半径 bevel）の高さ（mm） */
function jointProfile(e: number, halfJoint: number, bevel: number, depth: number): number {
  if (e < halfJoint) return -depth;
  if (e < halfJoint + bevel) {
    const t = 1 - (e - halfJoint) / bevel;
    return -Math.min(depth, bevel * (1 - Math.sqrt(1 - t * t)));
  }
  return 0;
}

/** 低解像度で計算したノイズを双線形補間で引く（大きな画像でも生成を速くする） */
class Grid {
  private d: Float32Array;
  constructor(private n: number, private m: number, fn: (u: number, v: number) => number) {
    this.d = new Float32Array(n * m);
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) this.d[j * n + i] = fn(i / n, j / m);
  }
  at(u: number, v: number): number {
    const x = u * this.n, y = v * this.m;
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const n = this.n, m = this.m;
    const i0 = ((i % n) + n) % n, i1 = (i0 + 1) % n, j0 = ((j % m) + m) % m, j1 = (j0 + 1) % m;
    const d = this.d;
    const a = d[j0 * n + i0], b = d[j0 * n + i1], c = d[j1 * n + i0], e = d[j1 * n + i1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
  }
}

/**
 * 斑点を画像に直接描き込む（被覆率 0..1 の配列を返す）。
 * 半分の斑点だけ乱数で決め、残りは 180度回転した位置に置くので点対称になる。
 */
function splatSpeckles(size: number, periodMM: number, count: number, rMin: number, rMax: number, seed: number): Float32Array {
  const cov = new Float32Array(size * size);
  const pxPerMM = size / periodMM;
  const dot = (cx: number, cy: number, rMM: number) => {
    const r = rMM * pxPerMM, rr = r + 0.6;
    for (let y = Math.floor(cy - rr); y <= Math.ceil(cy + rr); y++) {
      for (let x = Math.floor(cx - rr); x <= Math.ceil(cx + rr); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const c = smooth(r + 0.55, r - 0.55, d);
        if (c <= 0) continue;
        const i = (((y % size) + size) % size) * size + (((x % size) + size) % size);
        if (c > cov[i]) cov[i] = c;
      }
    }
  };
  for (let k = 0; k < count; k++) {
    const x = hash(k, 0, seed) * size, y = hash(k, 1, seed) * size;
    const r = rMin + (rMax - rMin) * Math.pow(hash(k, 2, seed), 1.6);
    dot(x, y, r);
    dot(size - x, size - y, r);
  }
  return cov;
}

// ================= 床 =================

/** 床の磁器質タイル（333mm角、御影石調の斑点、本磨きではなく半艶）。1m周期・点対称 */
export function floorTile(): PBRSet {
  const N = 1024, tiles = 3, tileMM = 1000 / tiles;
  const cloudG = new Grid(128, 128, (u, v) => sfbm(u, v, 9, 9, 33, 4) - 0.5);
  const fineG = new Grid(512, 512, (u, v) => sfbm(u, v, 160, 160, 37, 2) - 0.5);
  const dark = splatSpeckles(N, 1000, 15000, 0.35, 1.3, 41);
  const light = splatSpeckles(N, 1000, 6000, 0.4, 1.5, 47);
  const mid = splatSpeckles(N, 1000, 40000, 0.25, 0.7, 53);
  return build({
    w: N, h: N, mmU: 1000, mmV: 1000,
    fn: (u, v) => {
      const i = Math.floor(v * N) * N + Math.floor(u * N);
      const fx = (u * tiles) % 1, fy = (v * tiles) % 1;
      const e = Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)) * tileMM;
      const jh = jointProfile(e, 2.0, 1.4, 2.0);
      const inTile = smooth(1.8, 2.6, e);
      const cloud = cloudG.at(u, v);
      const fine = fineG.at(u, v);
      const dk = dark[i], lt = light[i] * (1 - dk), md = mid[i] * (1 - dk) * (1 - lt);
      let c = 0.63 + cloud * 0.07 + fine * 0.035 - dk * 0.33 + lt * 0.2 - md * 0.1;
      const grout = 0.43 + fine * 0.05;
      c = c * inTile + grout * (1 - inTile);
      const warm = 1 + cloud * 0.02;
      return {
        r: c * warm, g: c * 0.997, b: (c * 0.975) / warm,
        h: jh + inTile * (fine * 0.012 + cloud * 0.02),
        rough: inTile * (0.3 + cloud * 0.07 + fine * 0.05 - dk * 0.05) + (1 - inTile) * 0.9,
      };
    },
  });
}

/** 点字ブロック（線状・点状）。333mm 1枚分 */
export function tactile(kind: 'line' | 'dot'): PBRSet {
  const blockMM = 1000 / 3;
  const [yr, yg, yb] = hex(0xd8aa2c);
  return build({
    w: 256, h: 256, mmU: blockMM, mmV: blockMM,
    fn: (u, v) => {
      const x = u * blockMM, y = v * blockMM;
      const e = Math.min(x, blockMM - x, y, blockMM - y);
      const joint = jointProfile(e, 1.2, 1.2, 1.5);
      let bump = 0;
      if (kind === 'line') {
        // 4本の線状突起（上幅17mm・下幅27mm・高さ5mm、端は丸い）
        for (let k = 0; k < 4; k++) {
          const cx = blockMM / 2 + (k - 1.5) * 75;
          const dx = Math.abs(x - cx);
          const dy = Math.max(0, Math.abs(y - blockMM / 2) - 125);
          const d = Math.hypot(dx, dy);
          bump = Math.max(bump, smooth(13.5, 8.5, d));
        }
      } else {
        for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
          const cx = blockMM / 2 + (i - 2) * 58, cy = blockMM / 2 + (j - 2) * 58;
          const d = Math.hypot(x - cx, y - cy);
          bump = Math.max(bump, smooth(11, 4, d) * (1 - 0.15 * smooth(0, 4, d)));
        }
      }
      const n = sfbm(u, v, 12, 12, 71, 3) - 0.5;
      const grime = (1 - bump) * 0.1 + smooth(0.2, 0.6, sfbm(u, v, 5, 5, 73, 3)) * 0.05;
      const k = 0.93 + n * 0.08 - grime + bump * 0.05;
      return {
        r: yr * k, g: yg * k, b: yb * k * 0.96,
        h: joint + bump * 5 + n * 0.03,
        rough: 0.66 + n * 0.08 - bump * 0.12 + grime * 0.5,
      };
    },
  });
}

// ================= 壁 =================

/**
 * 帯より上の壁: 白い施釉タイル（約143mm角、芋目地）。1m x 1m 周期。
 * 釉薬は艶があり、蛍光灯がぼやけた像で映り込む。1枚ごとのわずかな反りで映り込みが目地ごとに少しずれる
 */
export function wallGlazedTile(): PBRSet {
  const n = 7, t = 1000 / n;
  return build({
    w: 1024, h: 1024, mmU: 1000, mmV: 1000,
    fn: (u, v) => {
      const x = u * 1000, y = v * 1000;
      const col = Math.floor(x / t), row = Math.floor(y / t);
      const fx = x - col * t, fy = y - row * t;
      const e = Math.min(fx, t - fx, fy, t - fy);
      const joint = jointProfile(e, 1.4, 2.4, 1.5);
      const k = smooth(1.1, 2.0, e);
      const tv = hash(col, row, 211) - 0.5;
      const tr = hash(col, row, 212) - 0.5;
      // 反り: 1枚ごとに傾きと中央のふくらみが少し違う
      const bx = fx / t - 0.5, by = fy / t - 0.5;
      const tiltX = (hash(col, row, 213) - 0.5) * 0.25, tiltY = (hash(col, row, 214) - 0.5) * 0.25;
      const bulge = (1 - (bx * bx + by * by) * 2.4) * 0.1 + bx * tiltX + by * tiltY;
      const wav = fbm(u, v, 24, 24, 215, 3) - 0.5;
      const pin = fbm(u, v, 300, 300, 217, 2) - 0.5;
      const c = 0.86 + tv * 0.025 + wav * 0.012 + pin * 0.008;
      const grout = 0.7 + pin * 0.05;
      return {
        r: c * k + grout * (1 - k), g: c * 0.997 * k + grout * 0.99 * (1 - k), b: c * 0.985 * k + grout * 0.96 * (1 - k),
        h: joint + k * (bulge + wav * 0.05 + pin * 0.006),
        rough: k * (0.09 + tr * 0.03 + wav * 0.025) + (1 - k) * 0.85,
      };
    },
  });
}

/** 腰壁: 施釉タイル（200x100mm、馬目地）。1m x 0.9m 周期 */
export function wallTile(): PBRSet {
  const tw = 200, th = 100;
  return build({
    w: 512, h: 512, mmU: 1000, mmV: 900,
    fn: (u, v) => {
      const x = u * 1000, y = v * 900;
      const row = Math.floor(y / th);
      const off = row % 2 ? tw / 2 : 0;
      const xx = ((x - off) % 1000 + 1000) % 1000;
      const col = Math.floor(xx / tw);
      const fx = xx - col * tw, fy = y - row * th;
      const e = Math.min(fx, tw - fx, fy, th - fy);
      const joint = jointProfile(e, 1.5, 2.2, 1.6);
      const inTile = smooth(1.2, 2.2, e);
      const tv = hash(col, row, 5) - 0.5;
      const tr = hash(col, row, 6) - 0.5;
      // 釉薬のふくらみとうねり（映り込みがわずかに歪む）
      const bx = fx / tw - 0.5, by = fy / th - 0.5;
      const bulge = (1 - (bx * bx * 3 + by * by * 3)) * 0.12;
      const wav = fbm(u, v, 18, 16, 111, 3) - 0.5;
      const pin = fbm(u, v, 260, 230, 113, 2) - 0.5;
      const c = 0.76 + tv * 0.04 + wav * 0.02 + pin * 0.01;
      const grout = 0.66 + pin * 0.04;
      const k = inTile;
      return {
        r: (c * 0.985) * k + grout * (1 - k), g: c * k + grout * 0.995 * (1 - k), b: (c * 0.985) * k + grout * 0.97 * (1 - k),
        h: joint + k * (bulge + wav * 0.06 + pin * 0.008),
        rough: k * (0.14 + tr * 0.05 + wav * 0.03) + (1 - k) * 0.86,
      };
    },
  });
}

/** 帯（色付きタイル）。色は材質の color で付けるので白で作る。1m x 0.12m 周期 */
export function bandTile(): PBRSet {
  const tw = 200;
  return build({
    w: 512, h: 64, mmU: 1000, mmV: 120,
    fn: (u, v) => {
      const x = u * 1000;
      const col = Math.floor(x / tw);
      const fx = x - col * tw;
      const e = Math.min(fx, tw - fx);
      const joint = jointProfile(e, 1.5, 2, 1.4);
      const inTile = smooth(1.2, 2.2, e);
      const tv = hash(col, 0, 7) - 0.5;
      const wav = fbm(u, v, 20, 3, 121, 3) - 0.5;
      const c = (0.93 + tv * 0.05 + wav * 0.025) * inTile + 0.78 * (1 - inTile);
      return {
        r: c, g: c, b: c,
        h: joint + inTile * (wav * 0.06 + 0.08 * (1 - Math.pow((fx / tw - 0.5) * 2, 2))),
        rough: inTile * (0.13 + tv * 0.05 + wav * 0.03) + (1 - inTile) * 0.85,
      };
    },
  });
}

/** 巾木（ビニル製、濃いグレー）。靴の擦れ跡 */
export function skirting(): PBRSet {
  return build({
    w: 512, h: 64, mmU: 1000, mmV: 100,
    fn: (u, v) => {
      const n = fbm(u, v, 60, 6, 131, 3) - 0.5;
      const scuff = smooth(0.62, 0.8, fbm(u, v, 9, 1, 133, 4)) * smooth(0.2, 0.6, 1 - v);
      const c = 0.245 + n * 0.02 - scuff * 0.08;
      return { r: c, g: c * 1.01, b: c * 1.03, h: n * 0.02, rough: 0.5 + n * 0.06 - scuff * 0.12 };
    },
  });
}

// ================= 天井 =================

/** 天井: 塗装したけい酸カルシウム板（1m x 0.5m、V目地とビス頭）。1m周期・点対称 */
export function ceilingBoard(): PBRSet {
  return build({
    w: 512, h: 512, mmU: 1000, mmV: 1000,
    fn: (u, v) => {
      const x = u * 1000, y = v * 1000;
      const ex = Math.min(x, 1000 - x);
      const ey = Math.min(y, 1000 - y, Math.abs(y - 500));
      const e = Math.min(ex, ey);
      const joint = jointProfile(e, 1.6, 1.8, 2.0);
      const inB = smooth(1.2, 2.4, e);
      let screw = 0;
      for (const sx of [125, 375, 625, 875]) {
        for (const sy of [18, 482, 518, 982]) {
          screw = Math.max(screw, smooth(3.2, 2.2, Math.hypot(x - sx, y - sy)));
        }
      }
      const stip = sfbm(u, v, 120, 120, 141, 3) - 0.5;
      const blot = sfbm(u, v, 6, 6, 143, 3) - 0.5;
      const c = 0.86 + stip * 0.02 + blot * 0.012 - screw * 0.05 - (1 - inB) * 0.15;
      return {
        r: c, g: c * 0.998, b: c * 0.99,
        h: joint + inB * stip * 0.08 - screw * 0.15,
        rough: 0.82 + stip * 0.06 + (1 - inB) * 0.1,
      };
    },
  });
}

// ================= 金属・塗装 =================

/** ステンレスのヘアライン（u方向に流れる）。細かな擦り傷つき */
export function brushedSteel(): PBRSet {
  const scratches = Array.from({ length: 14 }, (_, i) => ({
    x: hash(i, 1, 151), y: hash(i, 2, 151), a: (hash(i, 3, 151) - 0.5) * 2.4, l: 0.05 + hash(i, 4, 151) * 0.2,
  }));
  return build({
    w: 256, h: 256, mmU: 250, mmV: 250,
    fn: (u, v) => {
      const streak = fbm(u, v, 1, 96, 153, 3) - 0.5;
      const n = fbm(u, v, 8, 8, 155, 3) - 0.5;
      let s = 0;
      for (const q of scratches) {
        const dx = u - q.x, dy = v - q.y;
        const ca = Math.cos(q.a), sa = Math.sin(q.a);
        const along = dx * ca + dy * sa, across = -dx * sa + dy * ca;
        if (Math.abs(along) < q.l) s = Math.max(s, smooth(0.004, 0.0, Math.abs(across)) * (1 - Math.abs(along) / q.l));
      }
      const k = 0.8 + streak * 0.05 + n * 0.02;
      return { r: k * 0.98, g: k * 0.985, b: k, h: streak * 0.004, rough: 0.33 + streak * 0.1 + n * 0.06 + s * 0.2 };
    },
  });
}

/** アルミの梨地〜ヘアライン（額縁・見切り材） */
export function satinAluminium(): PBRSet {
  return build({
    w: 128, h: 128, mmU: 200, mmV: 200,
    fn: (u, v) => {
      const streak = fbm(u, v, 1, 64, 161, 3) - 0.5;
      const n = fbm(u, v, 10, 10, 163, 2) - 0.5;
      const k = 0.86 + streak * 0.03;
      return { r: k * 0.99, g: k, b: k * 1.0, h: streak * 0.002, rough: 0.36 + streak * 0.06 + n * 0.05 };
    },
  });
}

/** 焼付塗装の鋼板（ドア・消火栓・照明器具）。ゆず肌と小さな擦れ */
export function paintedSteel(tint: number, scuffAmount = 1): PBRSet {
  const c = hex(tint);
  return build({
    w: 256, h: 256, mmU: 500, mmV: 500,
    fn: (u, v) => {
      const peel = fbm(u, v, 40, 40, 171, 3) - 0.5;
      const scuff = smooth(0.7, 0.92, fbm(u, v, 6, 6, 173, 4)) * scuffAmount;
      const k = 0.98 + peel * 0.02 - scuff * 0.06;
      return { r: c[0] * k, g: c[1] * k, b: c[2] * k, h: peel * 0.04, rough: 0.34 + peel * 0.05 + scuff * 0.25 };
    },
  });
}

/** 換気口のガラリ */
export function vent(): PBRSet {
  return build({
    w: 128, h: 128, mmU: 600, mmV: 450,
    fn: (u, v) => {
      const slat = (v * 9) % 1;
      const hgt = slat < 0.7 ? slat / 0.7 : 0;
      const border = Math.min(u, 1 - u, v, 1 - v) < 0.05 ? 1 : 0;
      const n = fbm(u, v, 8, 8, 181, 2) - 0.5;
      const c = 0.62 + hgt * 0.12 + border * 0.1 + n * 0.04 - (1 - hgt) * (1 - border) * 0.25;
      return { r: c, g: c * 1.01, b: c * 1.02, h: border ? 6 : hgt * 8, rough: 0.45 + n * 0.1 };
    },
  });
}

/** 生地（シャツ・ズボン） */
export function fabric(tint: number): PBRSet {
  const c = hex(tint);
  return build({
    w: 128, h: 128, mmU: 60, mmV: 60,
    fn: (u, v) => {
      const weave = (Math.sin(u * Math.PI * 64) * Math.sin(v * Math.PI * 64) + 1) * 0.5;
      const n = fbm(u, v, 8, 8, 191, 3) - 0.5;
      const k = 0.94 + weave * 0.06 + n * 0.06;
      return { r: c[0] * k, g: c[1] * k, b: c[2] * k, h: weave * 0.08, rough: 0.85 + n * 0.08 };
    },
  });
}

// ================= 表面だけの粗さ・法線（印刷物用） =================

export interface SurfaceSet {
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function surface(w: number, mm: number, fn: (u: number, v: number) => { h: number; rough: number }): SurfaceSet {
  const s = build({ w, h: w, mmU: mm, mmV: mm, fn: (u, v) => ({ r: 1, g: 1, b: 1, ...fn(u, v) }) });
  s.map.dispose();
  return { normalMap: s.normalMap, roughnessMap: s.roughnessMap };
}

/** 広告の透明アクリルカバー: ほぼ鏡面だが、指紋・拭き跡・板のわずかなうねりがある */
export function acrylicCover(): SurfaceSet {
  return surface(256, 1000, (u, v) => {
    const smudge = smooth(0.58, 0.82, fbm(u, v, 5, 5, 201, 4));
    const wipe = smooth(0.55, 0.75, fbm(u, v, 1, 12, 203, 3)) * 0.5;
    const wav = fbm(u, v, 2, 2, 205, 2) - 0.5;
    return { h: wav * 0.5, rough: 0.05 + smudge * 0.16 + wipe * 0.06 };
  });
}

/** ラミネートした印刷物（案内板） */
export function laminate(): SurfaceSet {
  return surface(256, 400, (u, v) => {
    const n = fbm(u, v, 40, 40, 211, 3) - 0.5;
    const smudge = smooth(0.6, 0.85, fbm(u, v, 4, 4, 213, 4));
    return { h: n * 0.02, rough: 0.42 + n * 0.08 + smudge * 0.12 };
  });
}

/** ホーロー看板: 艶があり、鋼板のわずかなうねり */
export function enamel(): SurfaceSet {
  return surface(256, 1100, (u, v) => {
    const wav = fbm(u, v, 3, 3, 221, 3) - 0.5;
    const n = fbm(u, v, 30, 30, 223, 2) - 0.5;
    return { h: wav * 0.35, rough: 0.1 + n * 0.04 + smooth(0.65, 0.9, fbm(u, v, 4, 4, 225, 3)) * 0.08 };
  });
}

/** シャッターのスラット（横縞の凹凸）。周期 80mm */
export function shutterSlats(): SurfaceSet {
  return surface(128, 80, (u, v) => {
    const y = v * 80;
    const slat = y < 6 ? -1.2 * (1 - y / 6) : y > 74 ? -1.2 * ((y - 74) / 6) : Math.sin(((y - 6) / 68) * Math.PI) * 0.8;
    const n = fbm(u, v, 6, 1, 231, 3) - 0.5;
    return { h: slat, rough: 0.5 + n * 0.1 + (y < 6 || y > 74 ? 0.15 : 0) };
  });
}
