import * as THREE from 'three';
import { hash, smooth, wfbm } from './pbr';
import {
  AO_WALLS, CEIL_ITEMS, FIXTURE, H, LAMP_SPOTS, ROOMS, WALLS, canonFrame, symmetric, wallU,
} from './layout';

/*
 * 大きな陰影と汚れを、面ごとの小さな画像（アトラス）に焼き込む。uv1 で貼る。
 *   R: 環境遮蔽（隅・巾木・額縁まわり・器具まわりの陰り）
 *   G: 色の明るさ（0.5 = そのまま）
 *   B: 粗さの増減（0.5 = そのまま）
 *   A: 黄ばみ・くすみの量
 * 汚れの配置はループで重なる場所どうしで同じになるよう、layout の canonFrame / symmetric で決める。
 */

const PAD = 2;

export interface Region { x0: number; y0: number; wm: number; hm: number }

export class Atlas {
  readonly data: Uint8Array;
  private x = 0;
  private rowY = 0;
  private rowH = 0;
  constructor(readonly w: number, readonly h: number, readonly ppm: number) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4] = 255; this.data[i * 4 + 1] = 128; this.data[i * 4 + 2] = 128; this.data[i * 4 + 3] = 0;
    }
  }

  alloc(wm: number, hm: number): Region {
    const pw = Math.ceil(wm * this.ppm) + 2 * PAD;
    const ph = Math.ceil(hm * this.ppm) + 2 * PAD;
    if (this.x + pw > this.w) { this.rowY += this.rowH; this.x = 0; this.rowH = 0; }
    if (this.rowY + ph > this.h) throw new Error('atlas full');
    const r = { x0: this.x + PAD, y0: this.rowY + PAD, wm, hm };
    this.x += pw;
    this.rowH = Math.max(this.rowH, ph);
    return r;
  }

  uv(r: Region, sm: number, tm: number): [number, number] {
    return [(r.x0 + sm * this.ppm) / this.w, (r.y0 + tm * this.ppm) / this.h];
  }

  fill(r: Region, fn: (sm: number, tm: number) => [number, number, number, number]) {
    const pw = Math.ceil(r.wm * this.ppm), ph = Math.ceil(r.hm * this.ppm);
    for (let j = -PAD; j < ph + PAD; j++) {
      const tm = Math.min(r.hm, Math.max(0, (j + 0.5) / this.ppm));
      for (let i = -PAD; i < pw + PAD; i++) {
        const sm = Math.min(r.wm, Math.max(0, (i + 0.5) / this.ppm));
        const [ao, alb, rough, tint] = fn(sm, tm);
        const k = ((r.y0 + j) * this.w + r.x0 + i) * 4;
        this.data[k] = clampByte(ao * 255);
        this.data[k + 1] = clampByte(alb * 128);
        this.data[k + 2] = clampByte((rough + 0.5) * 255);
        this.data[k + 3] = clampByte(tint * 255);
      }
    }
  }

  texture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.data, this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.colorSpace = THREE.NoColorSpace;
    t.channel = 1;
    t.needsUpdate = true;
    return t;
  }
}

const clampByte = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
const ex = (d: number, l: number) => Math.exp(-Math.max(0, d) / l);

/** 平面上の点と線分の距離 */
function segDist(px: number, pz: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

/** 壁ぎわの陰り（床・天井用）。隅では2枚の壁の分が重なって濃くなる */
function wallProximity(x: number, z: number, near: number, nearL: number, far: number, farL: number) {
  let ao = 1;
  for (const w of AO_WALLS) {
    const side = (x - w.a[0]) * w.n[0] + (z - w.a[1]) * w.n[1];
    if (side < -0.02) continue;
    const d = segDist(x, z, w.a, w.b);
    if (d > 1.2) continue;
    ao *= 1 - near * ex(d, nearL) - far * ex(d, farL);
  }
  return Math.max(0.4, ao);
}

// ================= 壁 =================

/** 壁に付く物（額縁・ドア枠・消火栓など）。面の中心・法線・幅・高さ・出っ張り */
export interface WallProp { x: number; y: number; z: number; n: [number, number]; w: number; h: number; d: number }

export interface WallAtlas { tex: THREE.DataTexture; uv(seg: number, s: number, y: number): [number, number] }

export function bakeWalls(props: WallProp[]): WallAtlas {
  const atlas = new Atlas(2048, 512, 32);
  const regions: (Region | null)[] = WALLS.map((w) => (w.shutter ? null : atlas.alloc(w.len, H)));

  WALLS.forEach((w, si) => {
    const r = regions[si];
    if (!r) return;
    const tx = (w.b[0] - w.a[0]) / w.len, tz = (w.b[1] - w.a[1]) / w.len;
    const u0 = wallU(w.a[0], w.a[1], w.n);
    const myProps = props.filter((p) => p.n[0] === w.n[0] && p.n[1] === w.n[1] &&
      Math.abs((p.x - w.a[0]) * w.n[0] + (p.z - w.a[1]) * w.n[1]) < 0.2);
    atlas.fill(r, (s, y) => {
      const x = w.a[0] + tx * s, z = w.a[1] + tz * s;
      // ---- 形による陰り ----
      let ao = 1;
      if (y < 0.1) ao *= 1 - 0.3 * ex(y, 0.03); // 巾木の足もと
      else ao *= (1 - 0.14 * ex(y - 0.1, 0.025)) * (1 - 0.1 * ex(y, 0.25)); // 巾木の上・床からの広い陰り
      if (y < 0.99) ao *= 1 - 0.22 * ex(0.99 - y, 0.018); // 帯の下
      if (y > 1.12) ao *= 1 - 0.14 * ex(y - 1.12, 0.022); // 帯の上の段差
      ao *= 1 - 0.24 * ex(H - 0.035 - y, 0.035); // 廻り縁の下
      ao *= 1 - 0.12 * ex(H - y, 0.3);
      if (w.start === -1) ao *= 1 - 0.3 * ex(s, 0.11) - 0.08 * ex(s, 0.5);
      if (w.end === -1) ao *= 1 - 0.3 * ex(w.len - s, 0.11) - 0.08 * ex(w.len - s, 0.5);
      // ---- 取り付け物のまわり（上からの光なので下側に長く落ちる） ----
      for (const p of myProps) {
        const along = (x - p.x) * tx + (z - p.z) * tz;
        const up = y - p.y;
        const dx = Math.max(0, Math.abs(along) - p.w / 2);
        const dy = Math.max(0, Math.abs(up) - p.h / 2);
        const below = up < -p.h / 2 ? 1 : 0;
        const dist = Math.hypot(dx, dy * (below ? 0.55 : 1.3));
        const l = 0.012 + p.d * 0.5;
        const k = Math.min(0.45, 0.12 + p.d * 2.2);
        ao *= 1 - k * ex(dist, l) - k * 0.25 * ex(dist, l * 4);
      }

      // ---- 汚れ・ばらつき ----
      const u = u0 + s;
      const sc = w.a[0] + tx * (Math.floor(u) + 0.5 - u0), zc = w.a[1] + tz * (Math.floor(u) + 0.5 - u0);
      const pc = canonFrame(sc, zc);
      const pk = [Math.round(pc.x * 2), Math.round(pc.z * 2), Math.round(y > 1.12 ? 1 : 0)];
      let alb = 1, rough = 0, tint = 0;
      const blot = symmetric(x, z, (bx, bz) => wfbm(bx + y * 0.7, bz - y * 0.7, 0.8, 7, 4)) - 0.5;
      if (y >= 1.12) {
        // 上部タイル: 張り替えた区画のわずかな色の差、ムラ、手や荷物が触れる高さの薄汚れ（釉薬なので艶は変えない）
        alb *= 1 + (hash(pk[0], pk[1], 11) - 0.5) * 0.02 + blot * 0.02;
        tint += hash(pk[0], pk[1], 12) < 0.3 ? 0.12 + hash(pk[0], pk[1], 13) * 0.18 : 0.04;
        const rub = symmetric(x, z, (bx, bz) => wfbm(bx * 1.3, bz * 1.3 + y * 2, 0.5, 17, 3));
        const rubZone = smooth(1.12, 1.2, y) * smooth(1.65, 1.3, y);
        alb *= 1 - smooth(0.55, 0.75, rub) * rubZone * 0.05;
        rough += smooth(0.55, 0.75, rub) * rubZone * 0.04;
        // 天井近くのほこり・空調の黒ずみ
        alb *= 1 - smooth(2.45, 2.76, y) * 0.035 * (0.6 + blot);
        tint += smooth(2.4, 2.76, y) * 0.12;
        // まれに上から垂れた水じみ
        if (hash(pk[0], pk[1], 14) < 0.1) {
          const cu = (hash(pk[0], pk[1], 15) - 0.5) * 0.7 * pc.sign;
          const du = Math.abs(u - Math.floor(u) - 0.5 - cu);
          const len = 0.3 + hash(pk[0], pk[1], 16) * 0.6;
          const st = smooth(0.09, 0.02, du) * smooth(H - 0.04 - len, H - 0.06, y);
          alb *= 1 - st * 0.035;
          tint += st * 0.35;
        }
      } else if (y >= 0.99) {
        // 帯: 手が触れて艶が出る
        const rub = symmetric(x, z, (bx, bz) => wfbm(bx * 1.5, bz * 1.5, 0.4, 19, 3));
        rough -= smooth(0.5, 0.7, rub) * 0.05;
        alb *= 1 + blot * 0.02;
      } else if (y >= 0.1) {
        // 腰壁タイル: 床ぎわの跳ね・モップ跡、荷物の擦れ
        const splash = symmetric(x, z, (bx, bz) => wfbm(bx * 3, bz * 3, 0.35, 23, 4));
        const zone = smooth(0.32, 0.1, y + (splash - 0.5) * 0.12);
        alb *= 1 - zone * 0.07 + blot * 0.02;
        tint += zone * 0.25;
        rough += zone * 0.08;
        const rub = symmetric(x, z, (bx, bz) => wfbm(bx * 2, bz * 2 + y, 0.45, 29, 3));
        alb *= 1 - smooth(0.6, 0.78, rub) * smooth(0.6, 0.85, y) * 0.03;
      } else {
        // 巾木: 靴の黒い擦れ
        const sc2 = symmetric(x, z, (bx, bz) => wfbm(bx * 4, bz * 4, 0.3, 31, 3));
        alb *= 1 - smooth(0.6, 0.8, sc2) * 0.25;
        rough -= smooth(0.6, 0.8, sc2) * 0.1;
      }
      return [ao, alb, rough, Math.min(1, tint)];
    });
  });

  const tex = atlas.texture();
  return {
    tex,
    uv: (seg, s, y) => {
      const r = regions[seg]!;
      return atlas.uv(r, Math.min(r.wm, Math.max(0, s)), Math.min(H, Math.max(0, y)));
    },
  };
}

// ================= 床・天井 =================

export interface RoomAtlas { tex: THREE.DataTexture; uv(room: number, x: number, z: number): [number, number] }

/** 部屋の長手方向を atlas の横にとる */
function roomLocal(room: number, x: number, z: number): [number, number] {
  const { rect, alongX } = ROOMS[room];
  return alongX ? [x - rect[0], z - rect[2]] : [z - rect[2], x - rect[0]];
}
function roomWorld(room: number, sm: number, tm: number): [number, number] {
  const { rect, alongX } = ROOMS[room];
  return alongX ? [rect[0] + sm, rect[2] + tm] : [rect[0] + tm, rect[2] + sm];
}
function roomSize(room: number): [number, number] {
  const { rect, alongX } = ROOMS[room];
  const w = rect[1] - rect[0], d = rect[3] - rect[2];
  return alongX ? [w, d] : [d, w];
}

function bakeRooms(w: number, h: number, ppm: number, fn: (x: number, z: number, room: number) => [number, number, number, number]): RoomAtlas {
  const atlas = new Atlas(w, h, ppm);
  // 長い順に詰める
  const order = ROOMS.map((_, i) => i).sort((a, b) => roomSize(b)[0] - roomSize(a)[0]);
  const regions: Region[] = [];
  order.forEach((i) => {
    const [sw, sh] = roomSize(i);
    regions[i] = atlas.alloc(sw, sh);
  });
  ROOMS.forEach((_, i) => atlas.fill(regions[i], (sm, tm) => {
    const [x, z] = roomWorld(i, sm, tm);
    return fn(x, z, i);
  }));
  return {
    tex: atlas.texture(),
    uv: (room, x, z) => {
      const [sm, tm] = roomLocal(room, x, z);
      return atlas.uv(regions[room], sm, tm);
    },
  };
}

export function bakeFloor(): RoomAtlas {
  return bakeRooms(2048, 512, 48, (x, z) => {
    // 巾木ぎわの陰り（細い接触影 + 広い陰り）
    const ao = wallProximity(x, z, 0.34, 0.045, 0.12, 0.28);
    // 壁ぎわにたまるほこり（モップが届かない）
    let dWall = 9;
    for (const w of AO_WALLS) {
      const side = (x - w.a[0]) * w.n[0] + (z - w.a[1]) * w.n[1];
      if (side > -0.02) dWall = Math.min(dWall, segDist(x, z, w.a, w.b));
    }
    const dustN = symmetric(x, z, (bx, bz) => wfbm(bx, bz, 0.25, 41, 3));
    const dust = ex(dWall - 0.012, 0.035 + dustN * 0.04);
    // タイルごとのばらつき（333mm）
    const ti = Math.floor(x * 3), tj = Math.floor(z * 3);
    const tc = canonFrame((ti + 0.5) / 3, (tj + 0.5) / 3);
    const tk = [Math.round(tc.x * 6), Math.round(tc.z * 6)];
    const tv = hash(tk[0], tk[1], 51) - 0.5;
    const replaced = hash(tk[0], tk[1], 52) < 0.04 ? 1 : 0; // 張り替えたタイルはわずかに色が違う
    // 大きなむら、人の通り道（中央寄りはわずかに艶が出て黒ずむ）
    const blot = symmetric(x, z, (bx, bz) => wfbm(bx, bz, 2.2, 43, 4)) - 0.5;
    const scuff = symmetric(x, z, (bx, bz) => wfbm(bx * 1.7, bz * 1.7, 0.6, 47, 4));
    const lane = Math.min(1, dWall / 0.9);
    // ガムの跡など、まれな小さな黒い点
    let spot = 0;
    if (hash(tk[0], tk[1], 53) < 0.07) {
      const ox = (hash(tk[0], tk[1], 54) - 0.5) * 0.24 * tc.sign, oz = (hash(tk[0], tk[1], 55) - 0.5) * 0.24 * tc.sign;
      const r = 0.012 + hash(tk[0], tk[1], 56) * 0.012;
      spot = smooth(r + 0.012, r - 0.004, Math.hypot(x - ((ti + 0.5) / 3 + ox), z - ((tj + 0.5) / 3 + oz)));
    }
    let alb = 1 + tv * 0.05 + replaced * 0.06 + blot * 0.05 - lane * 0.025 - smooth(0.55, 0.8, scuff) * lane * 0.04;
    alb *= 1 - dust * 0.22 - spot * 0.35;
    const rough = tv * 0.08 + blot * 0.06 - lane * 0.05 + dust * 0.18 + spot * 0.2 - replaced * 0.05;
    return [ao, alb, rough, dust * 0.5 + spot * 0.4 + lane * 0.05];
  });
}

export function bakeCeiling(): RoomAtlas {
  return bakeRooms(1024, 256, 24, (x, z, room) => {
    let ao = wallProximity(x, z, 0.26, 0.05, 0.1, 0.3);
    let tint = 0;
    // 照明器具まわり（器具の外形からの距離）
    for (const l of LAMP_SPOTS) {
      const hx = (l.alongX ? FIXTURE.len : FIXTURE.w) / 2, hz = (l.alongX ? FIXTURE.w : FIXTURE.len) / 2;
      const dx = Math.max(0, Math.abs(x - l.x) - hx), dz = Math.max(0, Math.abs(z - l.z) - hz);
      const d = Math.hypot(dx, dz);
      if (d > 1) continue;
      ao *= 1 - 0.4 * ex(d, 0.045) - 0.1 * ex(d, 0.25);
      tint += ex(d, 0.12) * 0.25;
    }
    for (const c of CEIL_ITEMS) {
      const rad = c.kind === 'speaker' ? 0.11 : c.kind === 'emergency' ? 0.09 : c.kind === 'smoke' ? 0.055 : 0.02;
      const d = Math.max(0, Math.hypot(x - c.x, z - c.z) - rad);
      if (d < 0.5) ao *= 1 - 0.3 * ex(d, 0.02);
    }
    // 板ごとのばらつき（長手1m x 0.5m）、まれな雨じみ
    const along = ROOMS[room].alongX;
    const bi = along ? Math.floor(x) + 0.5 : Math.floor(x * 2) / 2 + 0.25;
    const bj = along ? Math.floor(z * 2) / 2 + 0.25 : Math.floor(z) + 0.5;
    const bc = canonFrame(bi, bj);
    const bk = [Math.round(bc.x * 4), Math.round(bc.z * 4)];
    const bv = hash(bk[0], bk[1], 61) - 0.5;
    const blot = symmetric(x, z, (bx, bz) => wfbm(bx, bz, 1.6, 63, 4)) - 0.5;
    let alb = 1 + bv * 0.03 + blot * 0.035;
    tint += hash(bk[0], bk[1], 62) < 0.25 ? 0.15 : 0.03;
    if (hash(bk[0], bk[1], 64) < 0.06) {
      const ox = (hash(bk[0], bk[1], 65) - 0.5) * 0.4 * bc.sign, oz = (hash(bk[0], bk[1], 66) - 0.5) * 0.2 * bc.sign;
      const rr = 0.12 + hash(bk[0], bk[1], 67) * 0.12;
      const d = Math.hypot(x - bi - ox, z - bj - oz);
      const wob = symmetric(x, z, (bx, bz) => wfbm(bx * 3, bz * 3, 0.2, 68, 2)) - 0.5;
      const ring = smooth(rr * 0.9, rr, d + wob * 0.05) * smooth(rr + 0.03, rr, d + wob * 0.05);
      const inner = smooth(rr, rr * 0.5, d + wob * 0.05);
      alb *= 1 - ring * 0.06 - inner * 0.015;
      tint += ring * 0.5 + inner * 0.15;
    }
    return [ao, alb, blot * 0.04, Math.min(1, tint)];
  });
}
