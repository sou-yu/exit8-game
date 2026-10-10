import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { H, LS, LM, M_CENTER, ROOMS, W, WALLS, canonFrame, wallU, type WallSeg } from './layout';
import type { RoomAtlas, WallAtlas } from './bake';
import { hash } from './pbr';

/*
 * 通路の外殻（壁・床・天井）を、材質ごとに1つのメッシュにまとめて作る。
 * 壁は断面形（巾木・腰壁タイル・帯・上部タイル・廻り縁）を外周に沿って押し出す。
 * 出っ張りのある部材は、入隅では短く・出隅では長くして角で突き合わせる。
 *   uv  : 実寸（m）。材質の細かな模様を貼る
 *   uv1 : 焼き込みアトラス（陰り・汚れ）
 */

type V3 = [number, number, number];

export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  uv1: number[] = [];
  idx: number[] = [];

  vert(p: V3, n: V3, uv: [number, number], uv1: [number, number]) {
    this.pos.push(...p);
    this.nor.push(...n);
    this.uv.push(...uv);
    this.uv1.push(...uv1);
    return this.pos.length / 3 - 1;
  }

  /** 4頂点の面。法線の向きに合わせて巻き方向をそろえる */
  quad(a: number, b: number, c: number, d: number) {
    const P = this.pos, N = this.nor;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1 = [P[b * 3] - ax, P[b * 3 + 1] - ay, P[b * 3 + 2] - az];
    const e2 = [P[c * 3] - ax, P[c * 3 + 1] - ay, P[c * 3 + 2] - az];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const dot = cx * N[a * 3] + cy * N[a * 3 + 1] + cz * N[a * 3 + 2];
    if (dot >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(this.uv1, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** 断面の点（d: 壁面からの出、y: 高さ）。下から上へ並べる */
export type Profile = [number, number][];

/** 壁の断面（材質ごと） */
export const PROFILES = {
  skirting: [[0.012, 0], [0.012, 0.088], [0.008, 0.1]] as Profile,
  wainscot: [[0.008, 0.1], [0.008, 0.99]] as Profile,
  band: [[0.008, 0.99], [0.013, 0.996], [0.013, 1.114], [0.0105, 1.12], [0, 1.12]] as Profile,
  paint: [[0, 1.12], [0, H - 0.035]] as Profile,
  cornice: [[0, H - 0.035], [0.02, H - 0.035], [0.02, H - 0.006], [0.017, H]] as Profile,
};

function cornerShift(c: number, d: number) {
  return c === 1 ? -d : c === -1 ? d : 0; // 出隅: 延ばす / 入隅: 縮める
}

/** 1枚の壁に断面を押し出す。range で壁の一部だけにもできる */
export function extrude(geo: Geo, si: number, w: WallSeg, prof: Profile, atlas: WallAtlas, range?: [number, number]) {
  const tx = (w.b[0] - w.a[0]) / w.len, tz = (w.b[1] - w.a[1]) / w.len;
  const [nx, nz] = w.n;
  const r0 = range ? range[0] : 0, r1 = range ? range[1] : w.len;
  const sAt = (end: 0 | 1, d: number) => {
    if (end === 0) return r0 > 1e-6 ? r0 : cornerShift(w.start, d);
    return r1 < w.len - 1e-6 ? r1 : w.len - cornerShift(w.end, d);
  };
  for (let k = 0; k < prof.length - 1; k++) {
    const [d0, y0] = prof[k];
    const [d1, y1] = prof[k + 1];
    const dd = d1 - d0, dy = y1 - y0;
    const l = Math.hypot(dd, dy);
    const nd = dy / l, ny = -dd / l;
    const n: V3 = [nx * nd, ny, nz * nd];
    const flat = Math.abs(dy) < 1e-6;
    const P = (s: number, d: number, y: number) => {
      const p: V3 = [w.a[0] + tx * s + nx * d, y, w.a[1] + tz * s + nz * d];
      const uv: [number, number] = [wallU(p[0], p[2], w.n), flat ? y + d * 4 : y];
      return geo.vert(p, n, uv, atlas.uv(si, s, y));
    };
    const a = P(sAt(0, d0), d0, y0), b = P(sAt(1, d0), d0, y0);
    const c = P(sAt(1, d1), d1, y1), d = P(sAt(0, d1), d1, y1);
    geo.quad(a, b, c, d);
  }
}

/** 床・天井の板（部屋ごと）。天井は通路の向きに板を流す */
export function roomPlane(geo: Geo, room: number, y: number, down: boolean, atlas: RoomAtlas) {
  const { rect, alongX } = ROOMS[room];
  const n: V3 = [0, down ? -1 : 1, 0];
  const corners: [number, number][] = [[rect[0], rect[2]], [rect[1], rect[2]], [rect[1], rect[3]], [rect[0], rect[3]]];
  const ids = corners.map(([x, z]) => {
    const uv: [number, number] = down ? (alongX ? [x, z] : [z, x]) : [x, z];
    return geo.vert([x, y, z], n, uv, atlas.uv(room, x, z));
  });
  geo.quad(ids[0], ids[1], ids[2], ids[3]);
}

/** 判定通路の壁かどうか（帯の色を変える異変は判定通路の帯だけに効かせる） */
export function mRange(w: WallSeg): [number, number] | null {
  const x = w.a[0];
  if (Math.abs(w.a[0] - w.b[0]) > 1e-6 || (x !== LS - W && x !== LS)) return null;
  const tz = Math.sign(w.b[1] - w.a[1]);
  const s0 = (Math.max(Math.min(w.a[1], w.b[1]), -LM) - w.a[1]) * tz;
  const s1 = (Math.min(Math.max(w.a[1], w.b[1]), 0) - w.a[1]) * tz;
  const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
  return hi - lo > 0.5 ? [lo, hi] : null;
}

/** 出隅のコーナーガード（ステンレスのL形） */
export function cornerGuards(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const N = WALLS.length;
  for (let i = 0; i < N; i++) {
    const w = WALLS[i];
    if (w.shutter || w.end !== 1) continue;
    const w2 = WALLS[(i + 1) % N];
    const d = 0.016, leg = 0.045, th = 0.0015;
    const cx = w.b[0] + w.n[0] * d + w2.n[0] * d, cz = w.b[1] + w.n[1] * d + w2.n[1] * d;
    const y0 = 0.1, y1 = H - 0.035;
    for (const [seg, dir] of [[w, -1], [w2, 1]] as const) {
      const tx = (seg.b[0] - seg.a[0]) / seg.len, tz = (seg.b[1] - seg.a[1]) / seg.len;
      const g = new RoundedBoxGeometry(leg, y1 - y0, th, 1, 0.0007);
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(tx, 0, tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(seg.n[0], 0, seg.n[1]),
      );
      m.setPosition(cx + tx * dir * leg / 2 - seg.n[0] * th / 2, (y0 + y1) / 2, cz + tz * dir * leg / 2 - seg.n[1] * th / 2);
      g.applyMatrix4(m);
      out.push(g);
    }
  }
  return out;
}

/**
 * 判定通路の中央を横切るエキスパンションジョイントのカバー（床と天井）。
 * 壁側のカバーは柱のように見えてポスターを横切るので付けない。
 */
export function expansionJoint(): { floor: THREE.BufferGeometry; ceiling: THREE.BufferGeometry } {
  const z = M_CENTER.y, wdt = 0.1;
  const floor = new RoundedBoxGeometry(W - 0.024, 0.008, wdt, 2, 0.003);
  floor.translate(M_CENTER.x, 0.0, z);
  const ceiling = new RoundedBoxGeometry(W - 0.04, 0.006, wdt, 2, 0.002);
  ceiling.translate(M_CENTER.x, H - 0.002, z);
  floor.deleteAttribute('uv');
  ceiling.deleteAttribute('uv');
  return { floor, ceiling };
}

/** 点字ブロックの並び（線状は進行方向に、曲がり角は点状） */
export function tactileLayout(): { line: THREE.Matrix4[]; dot: THREE.Matrix4[]; lineKeys: number[]; dotKeys: number[] } {
  const t = 1 / 3;
  const line: THREE.Matrix4[] = [], dot: THREE.Matrix4[] = [];
  const lineKeys: number[] = [], dotKeys: number[] = [];
  const corners: [number, number][] = [[W / 2, W / 2], [LS - W / 2, W / 2], [LS - W / 2, -LM - W / 2], [2 * LS - 1.5 * W, -LM - W / 2]];
  const key = (x: number, z: number) => {
    const c = canonFrame(x, z);
    return hash(Math.round(c.x * 6), Math.round(c.z * 6), 77);
  };
  const place = (x: number, z: number, alongX: boolean, isDot: boolean) => {
    const m = new THREE.Matrix4().makeRotationY(alongX ? Math.PI / 2 : 0);
    m.multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    m.setPosition(x, 0.002, z);
    (isDot ? dot : line).push(m);
    (isDot ? dotKeys : lineKeys).push(key(x, z));
  };
  corners.forEach(([x, z]) => place(x, z, false, true));
  const run = (x0: number, z0: number, x1: number, z1: number) => {
    const alongX = Math.abs(x1 - x0) > 1e-6;
    const n = Math.round((alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0)) / t);
    const sx = Math.sign(x1 - x0) * t, sz = Math.sign(z1 - z0) * t;
    for (let i = 1; i <= n; i++) {
      const x = x0 + sx * i, z = z0 + sz * i;
      if (corners.some(([cx, cz]) => Math.abs(cx - x) < 1e-3 && Math.abs(cz - z) < 1e-3)) continue;
      place(x, z, alongX, false);
    }
  };
  run(W / 2, W / 2, W / 2, W + 10 - t / 2); // 後方通路（シャッターまで）
  run(W / 2, W / 2, LS - W / 2, W / 2);
  run(LS - W / 2, W / 2, LS - W / 2, -LM - W / 2);
  run(LS - W / 2, -LM - W / 2, 2 * LS - 1.5 * W, -LM - W / 2);
  run(2 * LS - 1.5 * W, -LM - W / 2, 2 * LS - 1.5 * W, -LM - W - 12 + t / 2);
  return { line, dot, lineKeys, dotKeys };
}
