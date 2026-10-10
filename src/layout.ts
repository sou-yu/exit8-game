import * as THREE from 'three';

/*
 * ステージの座標（上から見た図、単位m、-Z が「奥」）
 *
 *   後方通路 (x 0..3, z 3..13)  ← 通行止めシャッター
 *        |
 *   待合 S_A (x 0..10, z 0..3)  ← 番号看板・きまり
 *                    |
 *          判定通路 M (x 7..10, z -30..0)  ← 異変が起きる通路
 *                    |
 *              待合 S_B (x 7..17, z -33..-30)
 *                             |
 *                     前方通路 (x 14..17, z -45..-33)
 *
 * 判定後はプレイヤーを座標変換して S_A 側に戻すことで、継ぎ目なしにループさせる。
 *  - 前進: (x, z) + (W - LS, W + LM) の平行移動（S_B → S_A）
 *  - 引き返し: S_A の中心まわりに180度回転
 * このため、汚れ・照明の個体差などの「ばらつき」は、移り変わる先どうしで同じになるよう
 * canonKey / symmetric で基準の場所に寄せてから決める。
 */
export const W = 3; // 通路幅
export const H = 2.8; // 天井高
export const LS = 10; // 待合の長さ
export const LM = 30; // 判定通路の長さ
export const BACK_LEN = 10;
export const FRONT_LEN = 12;

export const S_CENTER = new THREE.Vector2(LS / 2, W / 2);
export const FORWARD_SHIFT = new THREE.Vector2(W - LS, W + LM);
/** 判定通路の中心（通路はこの点まわりの180度回転で自分自身に重なる） */
export const M_CENTER = new THREE.Vector2(LS - W / 2, -LM / 2);

export type Rect = [number, number, number, number]; // x0, x1, z0, z1

export const WALKABLE: Rect[] = [
  [0, W, W, W + BACK_LEN - 0.4],
  [0, LS, 0, W],
  [LS - W, LS, -LM, 0],
  [LS - W, 2 * LS - W, -LM - W, -LM],
  [2 * LS - 2 * W, 2 * LS - W, -LM - W - FRONT_LEN, -LM - W],
];

/** 床・天井の区画。axis は通路の向き（天井板の長手方向） */
export const ROOMS: { rect: Rect; alongX: boolean; isM: boolean }[] = [
  { rect: [0, W, W, W + BACK_LEN], alongX: false, isM: false },
  { rect: [0, LS, 0, W], alongX: true, isM: false },
  { rect: [LS - W, LS, -LM, 0], alongX: false, isM: true },
  { rect: [LS - W, 2 * LS - W, -LM - W, -LM], alongX: true, isM: false },
  { rect: [2 * LS - 2 * W, 2 * LS - W, -LM - W - FRONT_LEN, -LM - W], alongX: false, isM: false },
];

// 外周（内側が左手側になる向き）。最後の辺はシャッター
const OUTLINE: [number, number][] = [
  [0, W + BACK_LEN], [0, 0], [LS - W, 0], [LS - W, -LM], [LS - W, -LM - W],
  [2 * LS - 2 * W, -LM - W], [2 * LS - 2 * W, -LM - W - FRONT_LEN],
  [2 * LS - W, -LM - W - FRONT_LEN], [2 * LS - W, -LM], [LS, -LM], [LS, W],
  [W, W], [W, W + BACK_LEN],
];

export type Corner = -1 | 0 | 1; // -1 入隅, 0 まっすぐ, 1 出隅

export interface WallSeg {
  a: [number, number];
  b: [number, number];
  /** 室内側を向く法線 */
  n: [number, number];
  len: number;
  start: Corner;
  end: Corner;
  shutter: boolean;
}

function cornerAt(prev: [number, number], cur: [number, number], next: [number, number]): Corner {
  const d1x = cur[0] - prev[0], d1z = cur[1] - prev[1];
  const d2x = next[0] - cur[0], d2z = next[1] - cur[1];
  const cross = d1x * d2z - d1z * d2x;
  return cross > 1e-9 ? -1 : cross < -1e-9 ? 1 : 0;
}

export const WALLS: WallSeg[] = OUTLINE.map((a, i) => {
  const N = OUTLINE.length;
  const b = OUTLINE[(i + 1) % N];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  return {
    a, b, len,
    n: [-dz / len, dx / len] as [number, number],
    start: cornerAt(OUTLINE[(i - 1 + N) % N], a, b),
    end: cornerAt(a, b, OUTLINE[(i + 2) % N]),
    shutter: i === N - 1,
  };
});

/** 壁に向かって立ったときの右方向の座標（壁のテクスチャの u）。ループの変換で整数だけずれる */
export function wallU(x: number, z: number, n: [number, number]) {
  return x * n[1] - z * n[0];
}

export function inM(x: number, z: number) {
  return x >= LS - W - 1e-6 && x <= LS + 1e-6 && z <= 1e-6 && z >= -LM - 1e-6;
}

/** 後方通路・S_B・前方通路の点を、ループで重なる M / S_A の点へ移す */
export function toBase(x: number, z: number): [number, number] {
  if (z > W + 1e-9) return [LS - x, W - z]; // 後方通路 → M（S_A 中心まわりの回転）
  if (z < -LM - 1e-9) return [x + FORWARD_SHIFT.x, z + FORWARD_SHIFT.y]; // S_B → S_A, 前方通路 → M
  return [x, z];
}

/**
 * ループで重なる「基準の場所」への写し。sign=-1 は 180度回転を含むことを表す
 * （向きのある模様、たとえばタイル内の染みの位置は sign を掛けて置く）。
 */
export function canonFrame(x: number, z: number): { x: number; z: number; sign: number } {
  let sign = z > W + 1e-9 ? -1 : 1;
  let [bx, bz] = toBase(x, z);
  if (bz < -1e-9) {
    if (bz < M_CENTER.y) { bx = 2 * M_CENTER.x - bx; bz = 2 * M_CENTER.y - bz; sign = -sign; }
  } else if (bx < S_CENTER.x) {
    bx = 2 * S_CENTER.x - bx; bz = 2 * S_CENTER.y - bz; sign = -sign;
  }
  return { x: Math.round(bx * 1000) / 1000, z: Math.round(bz * 1000) / 1000, sign };
}

/** 対称な2点が同じ値になるキー（タイル・パネルごとのばらつき用） */
export function canonKey(x: number, z: number): [number, number] {
  let [bx, bz] = toBase(x, z);
  if (bz < -1e-9) {
    if (bz < M_CENTER.y) { bx = 2 * M_CENTER.x - bx; bz = 2 * M_CENTER.y - bz; }
  } else if (bx < S_CENTER.x) {
    bx = 2 * S_CENTER.x - bx; bz = 2 * S_CENTER.y - bz;
  }
  return [Math.round(bx * 1000) / 1000, Math.round(bz * 1000) / 1000];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 連続した量（汚れの濃淡など）を、ループの変換に対して矛盾しないよう対称化して評価する */
export function symmetric(x: number, z: number, fn: (x: number, z: number) => number): number {
  const [bx, bz] = toBase(x, z);
  let s: number, rx: number, rz: number;
  if (bz < -1e-9) {
    s = smooth(M_CENTER.y + 1, M_CENTER.y - 1, bz);
    rx = 2 * M_CENTER.x - bx; rz = 2 * M_CENTER.y - bz;
  } else {
    s = smooth(S_CENTER.x + 1, S_CENTER.x - 1, bx);
    rx = 2 * S_CENTER.x - bx; rz = 2 * S_CENTER.y - bz;
  }
  if (s <= 0) return fn(bx, bz);
  if (s >= 1) return fn(rx, rz);
  return fn(bx, bz) * (1 - s) + fn(rx, rz) * s;
}

/** 半径 r の体が歩ける場所か */
export function canStand(x: number, z: number, r: number): boolean {
  const pts = [[x - r, z - r], [x + r, z - r], [x - r, z + r], [x + r, z + r]];
  return pts.every(([px, pz]) => WALKABLE.some((w) => px >= w[0] && px <= w[1] && pz >= w[2] && pz <= w[3]));
}

/** 汚れ・陰りの計算用: 一直線に続く壁はまとめた外周 */
export const AO_WALLS: { a: [number, number]; b: [number, number]; n: [number, number]; len: number }[] = (() => {
  const out: { a: [number, number]; b: [number, number]; n: [number, number]; len: number }[] = [];
  for (const w of WALLS) {
    const last = out[out.length - 1];
    if (last && last.n[0] === w.n[0] && last.n[1] === w.n[1] && last.b[0] === w.a[0] && last.b[1] === w.a[1]) {
      last.b = w.b;
      last.len = Math.hypot(last.b[0] - last.a[0], last.b[1] - last.a[1]);
    } else {
      out.push({ a: w.a, b: w.b, n: w.n, len: w.len });
    }
  }
  return out;
})();

/*
 * 照明器具。判定通路は中心まわりに対称（flip は器具を180度回して置く）、
 * 待合・前後の通路はループで重なる器具と同じ個体（variant）にする。
 */
export interface LampSpot {
  x: number;
  z: number;
  alongX: boolean;
  inM: boolean;
  variant: number;
  flip: boolean;
}
const mz = LS - W / 2;
export const LAMP_SPOTS: LampSpot[] = [
  { x: mz, z: -3, alongX: false, inM: true, variant: 0, flip: false },
  { x: mz, z: -7, alongX: false, inM: true, variant: 1, flip: false },
  { x: mz, z: -11, alongX: false, inM: true, variant: 2, flip: false },
  { x: mz, z: -15, alongX: false, inM: true, variant: 3, flip: false },
  { x: mz, z: -19, alongX: false, inM: true, variant: 2, flip: true },
  { x: mz, z: -23, alongX: false, inM: true, variant: 1, flip: true },
  { x: mz, z: -27, alongX: false, inM: true, variant: 0, flip: true },
  { x: 2.5, z: W / 2, alongX: true, inM: false, variant: 4, flip: false },
  { x: 7.5, z: W / 2, alongX: true, inM: false, variant: 4, flip: true },
  { x: 9.5, z: -LM - W / 2, alongX: true, inM: false, variant: 4, flip: false },
  { x: 14.5, z: -LM - W / 2, alongX: true, inM: false, variant: 4, flip: true },
  { x: W / 2, z: 6, alongX: false, inM: false, variant: 0, flip: true },
  { x: W / 2, z: 10, alongX: false, inM: false, variant: 1, flip: true },
  { x: 2 * LS - 1.5 * W, z: -36, alongX: false, inM: false, variant: 0, flip: false },
  { x: 2 * LS - 1.5 * W, z: -40, alongX: false, inM: false, variant: 1, flip: false },
  { x: 2 * LS - 1.5 * W, z: -44, alongX: false, inM: false, variant: 2, flip: false },
];
/** 器具の寸法（m）: 本体 長さ x 高さ x 幅、拡散カバー */
export const FIXTURE = { len: 1.25, h: 0.07, w: 0.23, coverLen: 1.2, coverH: 0.03, coverW: 0.19 };

export type CeilKind = 'smoke' | 'sprinkler' | 'speaker' | 'emergency';
export interface CeilItem { kind: CeilKind; x: number; z: number; inM: boolean }
/** 天井の小物（煙感知器・スプリンクラー・スピーカー・非常灯）。照明と同じく対称に置く */
export const CEIL_ITEMS: CeilItem[] = (() => {
  const items: CeilItem[] = [];
  const add = (kind: CeilKind, x: number, z: number) => items.push({ kind, x, z, inM: inM(x, z) && z < -0.01 });
  // 判定通路
  for (const z of [-5, -25]) add('smoke', mz, z);
  for (const z of [-9, -21]) add('emergency', mz, z);
  for (const z of [-13, -17]) add('speaker', mz, z);
  const spr: [number, number][] = [[9.1, -1], [7.9, -5], [9.1, -9], [7.9, -13], [9.1, -17], [7.9, -21], [9.1, -25], [7.9, -29]];
  spr.forEach(([x, z]) => add('sprinkler', x, z));
  // 後方通路 = 判定通路の手前側を S_A 中心で回したもの
  const back = (kind: CeilKind, x: number, z: number) => add(kind, LS - x, W - z);
  back('smoke', mz, -5); back('emergency', mz, -9);
  back('sprinkler', 9.1, -1); back('sprinkler', 7.9, -5); back('sprinkler', 9.1, -9);
  // 前方通路 = 判定通路の手前側を平行移動したもの
  const fw = (kind: CeilKind, x: number, z: number) => add(kind, x - FORWARD_SHIFT.x, z - FORWARD_SHIFT.y);
  fw('smoke', mz, -5); fw('emergency', mz, -9);
  fw('sprinkler', 9.1, -1); fw('sprinkler', 7.9, -5); fw('sprinkler', 9.1, -9);
  // 待合（S_A は中心まわりに対称、S_B はその平行移動）
  for (const [dx, dz] of [[0, 0], [-FORWARD_SHIFT.x, -FORWARD_SHIFT.y]]) {
    add('emergency', LS / 2 + dx, W / 2 + dz);
    add('sprinkler', 3.5 + dx, 0.9 + dz);
    add('sprinkler', 6.5 + dx, 2.1 + dz);
  }
  return items;
})();
