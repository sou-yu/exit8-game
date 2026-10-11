import * as THREE from 'three';

/*
 * 異変「換気口から赤い液体が垂れる」の小道具。
 * 換気口の下の縁から壁を伝う筋（壁の段差ごとに面を分け、各面の少し手前に貼る）、
 * 床の水たまり、縁にたまってから落ちるしずくと、水たまりに広がる波紋。
 * 東の壁（x = wallX、法線は -x）の換気口に合わせて置く。普段は非表示。
 */

/** 壁の断面（shell.ts と同じ値）: [下端, 上端, 壁面からの出っ張り] */
const WALL_STEPS: [number, number, number][] = [
  [0, 0.088, 0.012], // 巾木
  [0.1, 0.99, 0.008], // 腰壁タイル
  [0.996, 1.114, 0.013], // 帯
  [1.12, 2.115, 0], // 上部タイル（換気口の下端まで）
];
const VENT_BOTTOM = 2.115;
/** 換気口の前面（壁から 30mm）に付く、すき間から染み出した跡の高さ */
const VENT_SMEAR = 0.2;
const TOP = VENT_BOTTOM + VENT_SMEAR;
const STREAK_W = 0.46;
const PUDDLE_W = 0.75; // 壁から離れる向き（x）
const PUDDLE_L = 1.1; // 壁に沿う向き（z）
/** しずくが落ちる場所（換気口の中心からの z のずれ）。壁を伝う太い筋の上 */
const DRIP_DZ = 0.07;
const G = 9.8;

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

/** 筋の形（白 = 液体）。縦は 0（床）〜 TOP（換気口の前面の上端）を表す */
function streakMask(): THREE.CanvasTexture {
  const w = 192, h = 1280;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  const yOf = (m: number) => h * (1 - m / TOP);
  const xOf = (dz: number) => w * (0.5 + dz / STREAK_W);
  // 換気口の羽根のすき間から染み出して下の縁にたまった跡: 縁に沿った帯と、すき間から下りる短い筋
  g.fillRect(xOf(-0.2), yOf(VENT_BOTTOM + 0.014), xOf(0.2) - xOf(-0.2), yOf(VENT_BOTTOM) - yOf(VENT_BOTTOM + 0.014));
  for (let i = 0; i < 22; i++) {
    const dz = (rnd() - 0.5) * 0.38;
    const top = VENT_BOTTOM + 0.03 + rnd() * rnd() * (VENT_SMEAR - 0.04);
    const r = 2 + rnd() * 3;
    for (let m = top; m > VENT_BOTTOM; m -= 0.004) {
      g.beginPath();
      g.ellipse(xOf(dz), yOf(m), r * (0.7 + 0.6 * (top - m) / (top - VENT_BOTTOM)), 4, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 壁を伝う筋: [始まりの z, 太さ（m）, 届く高さ]。3本は床まで届いて水たまりにつながる
  const runs: [number, number, number][] = [
    [DRIP_DZ, 0.022, 0], [-0.09, 0.016, 0], [0.13, 0.012, 0],
    [-0.03, 0.01, 0.9], [0.02, 0.008, 1.45], [-0.15, 0.009, 1.2], [0.17, 0.007, 1.75], [-0.12, 0.006, 1.9],
  ];
  for (const [z0, th, end] of runs) {
    let dz = z0;
    let drift = 0;
    for (let m = VENT_BOTTOM + 0.01; m > end; m -= 0.004) {
      drift += (rnd() - 0.5) * 0.0006;
      drift *= 0.97;
      dz += drift;
      // 上ほど太く、下へ行くほど細くなる（途中で少しだまになる）
      const k = 0.55 + 0.45 * (m - end) / (VENT_BOTTOM - end);
      const r = (th * k * (0.9 + 0.2 * Math.sin(m * 37 + z0 * 50))) / STREAK_W * w * 0.5;
      g.beginPath();
      g.ellipse(xOf(dz), yOf(m), Math.max(1.2, r), 4, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (end > 0) {
      // 止まった先端のふくらみ
      g.beginPath();
      g.ellipse(xOf(dz), yOf(end), (th / STREAK_W) * w * 0.7, 9, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

/** 水たまりの形。右端（+x）が壁ぎわ */
function puddleMask(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, s, s);
  const blob = (x: number, y: number, rx: number, ry: number) => {
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grd.addColorStop(0, '#fff');
    grd.addColorStop(0.86, '#fff');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.save();
    g.translate(x, y);
    g.scale(rx, ry);
    g.fillStyle = grd;
    g.beginPath();
    g.arc(0, 0, 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  // 壁ぎわの筋が落ちる所を中心に広がった形（大きな塊＋縁の小さなふくらみ）
  blob(s * 0.72, s * 0.5, s * 0.27, s * 0.36);
  blob(s * 0.55, s * 0.6, s * 0.2, s * 0.22);
  blob(s * 0.9, s * 0.46, s * 0.12, s * 0.3);
  for (let i = 0; i < 28; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 0.25 + rnd() * 0.12;
    const x = s * (0.68 + Math.cos(a) * d * 0.9), y = s * (0.52 + Math.sin(a) * d * 1.1);
    if (x > s * 0.98) continue;
    const r = s * (0.02 + rnd() * 0.05);
    blob(x, y, r, r * (0.8 + rnd() * 0.4));
  }
  blob(s * 0.98, s * 0.5, s * 0.05, s * 0.4); // 壁との取り合いまで埋める
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

export interface Leak {
  group: THREE.Group;
  /** しずくを動かす。着地したら距離（m）を返す（音の大きさに使う） */
  update(dt: number, px: number, pz: number): number | null;
}

export function buildLeak(wallX: number, ventZ: number): Leak {
  seed = 7;
  const group = new THREE.Group();
  group.visible = false;
  // 濡れた赤黒い液体（暗い赤、強い艶）
  const wet = { color: 0x4a0706, roughness: 0.14, metalness: 0 };
  const streakMat = new THREE.MeshStandardMaterial({
    // 斜めから見たときにぼけた縁が白く光らないよう、薄い所は切り捨てる
    ...wet, alphaMap: streakMask(), transparent: true, alphaTest: 0.35, depthWrite: false, envMapIntensity: 0.6,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // 壁の段ごとに筋の面を貼る（テクスチャの縦は床からの高さで合わせる）
  const segs: [number, number, number][] = [...WALL_STEPS, [VENT_BOTTOM, TOP, 0.03]];
  for (const [y0, y1, off] of segs) {
    const geo = new THREE.PlaneGeometry(STREAK_W, y1 - y0);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, (y0 + uv.getY(i) * (y1 - y0)) / TOP);
    const m = new THREE.Mesh(geo, streakMat);
    m.rotation.y = -Math.PI / 2;
    m.position.set(wallX - off - 0.0015, (y0 + y1) / 2, ventZ);
    m.renderOrder = 2;
    group.add(m);
  }

  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0x330404, roughness: 0.05, metalness: 0, alphaMap: puddleMask(), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const puddle = new THREE.Mesh(new THREE.PlaneGeometry(PUDDLE_W, PUDDLE_L), puddleMat);
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(wallX - 0.012 - PUDDLE_W / 2, 0.006, ventZ + DRIP_DZ * 0.5);
  puddle.renderOrder = 2;
  group.add(puddle);

  // 換気口の下の縁にたまって落ちるしずく
  const dropMat = new THREE.MeshStandardMaterial({ ...wet, envMapIntensity: 0.35 });
  const drop = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 12, 8), dropMat);
  const lipX = wallX - 0.036;
  const lipY = VENT_BOTTOM - 0.006;
  const dropZ = ventZ + DRIP_DZ;
  drop.position.set(lipX, lipY, dropZ);
  group.add(drop);
  // 着地点に広がる波紋（艶のある輪が広がりながら消える）
  const rippleMat = new THREE.MeshStandardMaterial({
    color: 0x5a0c0a, roughness: 0.02, metalness: 0, transparent: true, opacity: 0, depthWrite: false,
  });
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), rippleMat);
  ripple.rotation.x = -Math.PI / 2;
  ripple.position.set(lipX, 0.0075, dropZ);
  ripple.renderOrder = 3;
  group.add(ripple);

  // 0: 縁でふくらむ、1: 落ちる
  let phase = 0, t = 0, vy = 0, grow = 1.1, rippleT = -1;
  return {
    group,
    update(dt, px, pz) {
      let landed: number | null = null;
      t += dt;
      if (phase === 0) {
        const k = Math.min(1, t / grow);
        drop.scale.set(k, k * (1 + 0.5 * k), k);
        drop.position.y = lipY - 0.006 * k;
        if (k >= 1) { phase = 1; t = 0; vy = 0; }
      } else {
        vy += G * dt;
        drop.position.y -= vy * dt;
        drop.scale.set(0.85, 1.6, 0.85); // 落ちる間は少し細長く
        if (drop.position.y <= 0.01) {
          phase = 0;
          t = 0;
          grow = 0.9 + Math.random() * 0.8;
          drop.position.y = lipY;
          drop.scale.setScalar(0.01);
          rippleT = 0;
          landed = Math.hypot(px - lipX, pz - dropZ);
        }
      }
      if (rippleT >= 0) {
        rippleT += dt;
        const k = rippleT / 0.7;
        ripple.scale.setScalar(0.01 + 0.07 * k);
        rippleMat.opacity = Math.max(0, 0.8 * (1 - k));
        if (k >= 1) rippleT = -1;
      }
      return landed;
    },
  };
}
