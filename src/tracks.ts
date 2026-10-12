import * as THREE from 'three';

/*
 * 異変「通路一面にペンギンの足跡」の小道具。
 * 濡れた黒っぽい足跡（指3本・水かき・爪）を、何本もの列にして判定通路の床に並べる。
 * 列はゆるく曲がりながら通路の端から端まで続き、多くはこちらへ向かって歩いてきた向き、いくつかは奥へ向かう向き。
 * 足跡は 1 枚の板を InstancedMesh でまとめて描く。普段は非表示。
 */

/** 足跡 1 つの大きさ（m）: 幅・長さ */
const PRINT_W = 0.2;
const PRINT_L = 0.21;
/** 1 歩の長さ、左右の足の間隔 */
const STEP = 0.21;
const GAIT = 0.055;

let seed = 11;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

/** 足跡の画像（上が指先）。色は濡れた黒、指の筋と爪は濃く、水かきは少し薄い。透明度に形を入れる */
function printTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const heel: [number, number] = [128, 226];
  const tips: [number, number][] = [[42, 52], [128, 18], [214, 52]];
  // 水かき: かかとから3本の指先へ広がる扇。指の間は少しえぐれる
  g.fillStyle = 'rgba(38,38,38,0.93)';
  g.beginPath();
  g.moveTo(heel[0] - 24, heel[1] - 4);
  g.lineTo(tips[0][0] - 4, tips[0][1] + 6);
  g.quadraticCurveTo(92, 58, tips[1][0] - 6, tips[1][1] + 8);
  g.lineTo(tips[1][0] + 6, tips[1][1] + 8);
  g.quadraticCurveTo(164, 58, tips[2][0] + 4, tips[2][1] + 6);
  g.lineTo(heel[0] + 24, heel[1] - 4);
  g.closePath();
  g.fill();
  // かかと
  g.fillStyle = 'rgba(30,30,30,0.9)';
  g.beginPath();
  g.ellipse(heel[0], heel[1] - 8, 26, 24, 0, 0, Math.PI * 2);
  g.fill();
  // 指の筋（かかとから指先へ細くなる）と、筋の上のうろこの小さな明るい点
  for (const [tx, ty] of tips) {
    const n = 26;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const x = heel[0] + (tx - heel[0]) * u, y = heel[1] - 10 + (ty - heel[1] + 10) * u;
      g.fillStyle = 'rgba(22,22,22,0.95)';
      g.beginPath();
      g.arc(x, y, 16 - 7 * u, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 1; i < 9; i++) {
      const u = 0.12 + i * 0.09;
      const x = heel[0] + (tx - heel[0]) * u, y = heel[1] - 10 + (ty - heel[1] + 10) * u;
      g.fillStyle = 'rgba(92,92,92,0.95)';
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.fill();
    }
    // 爪（指先の少し先の丸い跡）
    const dx = tx - heel[0], dy = ty - heel[1];
    const l = Math.hypot(dx, dy);
    g.fillStyle = 'rgba(8,8,8,1)';
    g.beginPath();
    g.arc(tx + (dx / l) * 6, ty + (dy / l) * 6, 9, 0, Math.PI * 2);
    g.fill();
  }
  // 濡れた跡のむら（ところどころ薄い）
  const id = g.getImageData(0, 0, S, S);
  for (let i = 0; i < id.data.length; i += 4) {
    if (id.data[i + 3] === 0) continue;
    id.data[i + 3] = Math.round(id.data[i + 3] * (0.85 + 0.15 * Math.random()));
  }
  g.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface Tracks {
  group: THREE.Group;
  count: number;
}

/** 判定通路の床（x0〜x1、z0〜z1。z0 > z1）に足跡を並べる */
export function buildTracks(x0: number, x1: number, z0: number, z1: number): Tracks {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    map: printTexture(), transparent: true, depthWrite: false, roughness: 0.55, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const geo = new THREE.PlaneGeometry(PRINT_W, PRINT_L);
  geo.rotateX(-Math.PI / 2); // 床に寝かせる。画像の上（指先）が -z を向く

  const mats: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const margin = 0.16;
  const TRAILS = 11;
  for (let k = 0; k < TRAILS; k++) {
    // 列ごとの通り道: 通路の幅にばらけた出発点から、ゆるく蛇行する
    const base = x0 + margin + ((k + 0.35 + rnd() * 0.3) / TRAILS) * (x1 - x0 - 2 * margin);
    const amp = 0.04 + rnd() * 0.13, freq = 0.15 + rnd() * 0.3, ph = rnd() * 6.28;
    const drift = (rnd() - 0.5) * 0.008; // 通路の長さ全体でゆっくり横へずれる
    const towardUs = rnd() < 0.72; // こちら（+z）へ歩いてきた列が多い
    const s = 0.92 + rnd() * 0.16; // ペンギンごとの足の大きさ
    const step = STEP * (0.9 + rnd() * 0.2);
    const xAt = (z: number) => THREE.MathUtils.clamp(base + amp * Math.sin(z * freq + ph) + drift * (z0 - z), x0 + margin, x1 - margin);
    let foot = rnd() < 0.5 ? 1 : -1;
    for (let z = z0 - 0.3 - rnd() * step; z > z1 + 0.3; z -= step) {
      const dz = 0.05;
      // 進む向き（列の接線）
      let hx = (xAt(z - dz) - xAt(z + dz)) / (2 * dz), hz = -1;
      if (towardUs) { hx = -hx; hz = 1; }
      const hl = Math.hypot(hx, hz);
      hx /= hl; hz /= hl;
      // 左右の足を交互に、進む向きの横へずらす。つま先は少し外向き
      const sideX = -hz * foot, sideZ = hx * foot;
      const jitter = (rnd() - 0.5) * 0.02;
      pos.set(xAt(z) + sideX * (GAIT + jitter), 0.006, z + sideZ * (GAIT + jitter));
      const yaw = Math.atan2(-hx, -hz) - foot * (0.12 + rnd() * 0.12) * (towardUs ? -1 : 1) + (rnd() - 0.5) * 0.12;
      q.setFromAxisAngle(up, yaw);
      scl.set(s, 1, s);
      mats.push(m.compose(pos, q, scl).clone());
      foot = -foot;
    }
  }
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((mm, i) => im.setMatrixAt(i, mm));
  im.receiveShadow = true;
  im.renderOrder = 1;
  im.frustumCulled = false;
  group.add(im);
  group.visible = false;
  return { group, count: mats.length };
}
