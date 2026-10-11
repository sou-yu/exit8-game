import * as THREE from 'three';

// 画像ファイルを使わず、すべての模様・広告・看板をcanvasで描く
const FONT = '"Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function text(
  g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number,
  color: string, weight = 'bold', align: CanvasTextAlign = 'center',
) {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

/** 1枚で tiles x tiles 個のタイルを描いたテクスチャ */
export function tileTexture(base: string, grout: string, tiles: number, noise = 6): THREE.CanvasTexture {
  const size = 256;
  const [c, g] = canvas(size, size);
  g.fillStyle = grout;
  g.fillRect(0, 0, size, size);
  const step = size / tiles;
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const v = Math.floor((Math.random() - 0.5) * noise);
      g.fillStyle = shade(base, v);
      g.fillRect(i * step + 1.5, j * step + 1.5, step - 3, step - 3);
    }
  }
  return toTexture(c, true);
}

function shade(hex: string, d: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + d));
  const gg = Math.max(0, Math.min(255, ((n >> 8) & 255) + d));
  const b = Math.max(0, Math.min(255, (n & 255) + d));
  return `rgb(${r},${gg},${b})`;
}

export function tactileTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = '#d9b42a';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#c29f1f';
  for (let i = 0; i < 4; i++) g.fillRect(6, i * 16 + 6, 52, 4);
  return toTexture(c, true);
}

export function ceilingTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#b9bcbc';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#9a9d9e';
  g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.stroke();
  }
  g.fillStyle = '#a7aaab';
  for (let i = 0; i < 300; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  return toTexture(c, true);
}

/** 通路の進行番号を示す壁の看板 */
export function numberSignTexture(n: number): THREE.CanvasTexture {
  const [c, g] = canvas(512, 384);
  g.fillStyle = '#1d5c48';
  g.fillRect(0, 0, 512, 384);
  g.strokeStyle = '#e8efe9';
  g.lineWidth = 6;
  g.strokeRect(14, 14, 484, 356);
  text(g, '地下連絡通路', 256, 62, 36, '#e8efe9');
  text(g, 'UNDERPASS', 256, 102, 22, '#a9d3c2', 'normal');
  g.fillStyle = '#e8efe9';
  g.beginPath();
  g.arc(256, 238, 96, 0, Math.PI * 2);
  g.fill();
  text(g, String(n), 256, 244, 140, '#1d5c48');
  text(g, '番', 400, 300, 40, '#e8efe9');
  return toTexture(c);
}

/** 通路の天井から下がる出口案内 */
export function hangingSignTexture(mode: 'normal' | 'reversed' | 'goal'): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 192);
  g.fillStyle = mode === 'goal' ? '#f2f2f2' : '#1d5c48';
  g.fillRect(0, 0, 1024, 192);
  const fg = mode === 'goal' ? '#1d5c48' : '#f4f4f0';
  // 矢印
  g.save();
  g.translate(150, 96);
  if (mode === 'reversed') g.rotate(Math.PI);
  g.fillStyle = fg;
  g.beginPath();
  g.moveTo(0, -62); g.lineTo(48, -6); g.lineTo(18, -6); g.lineTo(18, 60);
  g.lineTo(-18, 60); g.lineTo(-18, -6); g.lineTo(-48, -6);
  g.closePath();
  g.fill();
  g.restore();
  text(g, '8番出口', 470, 80, 76, fg);
  text(g, 'EXIT 8', 470, 148, 36, fg, 'normal');
  text(g, mode === 'goal' ? '地上へ' : '改札・地上', 820, 96, 46, fg);
  return toTexture(c);
}

/** 出口案内の裏に赤いスプレーで殴り書きした文字（異変）。透明の上に描く */
export function scrawlTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 192);
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const chars = [...'戻れ！戻れ！戻れ！'];
  let x = 80;
  for (const ch of chars) {
    const size = (ch === '！' ? 104 : 124) * (0.9 + rnd() * 0.2);
    const y = 92 + (rnd() - 0.5) * 22;
    const bang = ch === '！';
    g.save();
    g.translate(bang ? x - 34 : x, y);
    g.rotate((rnd() - 0.5) * 0.22);
    g.font = `900 ${size}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // スプレーのにじみ（薄く広く）→ 本体
    g.shadowColor = 'rgba(120,8,6,0.55)';
    g.shadowBlur = 7;
    g.fillStyle = '#8f0f0b';
    g.fillText(ch, 0, 0);
    g.restore();
    // 塗料の垂れ
    for (let k = 0; k < 2; k++) {
      if (rnd() < 0.45) continue;
      const dx = x + (rnd() - 0.5) * size * 0.6, y0 = y + size * 0.3, len = 10 + rnd() * 45;
      g.fillStyle = '#7d0c09';
      g.fillRect(dx - 1.5, y0, 3, len);
      g.beginPath();
      g.arc(dx, y0 + len, 3, 0, Math.PI * 2);
      g.fill();
    }
    x += ch === '！' ? 66 : 118;
  }
  return toTexture(c);
}

export function guideTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(640, 448);
  g.fillStyle = '#f3f1ea';
  g.fillRect(0, 0, 640, 448);
  g.fillStyle = '#1d5c48';
  g.fillRect(0, 0, 640, 80);
  text(g, '通路のきまり', 320, 42, 40, '#fff');
  const lines: [string, string][] = [
    ['いつもと違うところを見つけたら', '引き返してください'],
    ['何も変わっていなければ', 'そのまま進んでください'],
    ['8番出口から', '地上へ出られます'],
  ];
  lines.forEach(([a, b], i) => {
    const y = 140 + i * 105;
    text(g, `${i + 1}.`, 44, y + 14, 34, '#1d5c48', 'bold', 'left');
    text(g, a, 92, y, 30, '#222', 'bold', 'left');
    text(g, b, 92, y + 40, 30, '#222', 'bold', 'left');
  });
  return toTexture(c);
}

export type PosterKind = 'bath' | 'bakery' | 'eye' | 'books' | 'manner';

/** strange: 異変の絵（眼科だけは 'phone' で電話番号だけが変わる） */
export function posterTexture(kind: PosterKind, strange: boolean | 'phone' = false): THREE.CanvasTexture {
  const phone = strange === 'phone';
  if (phone) strange = false;
  const [c, g] = canvas(360, 504);
  switch (kind) {
    case 'bath': {
      g.fillStyle = '#2a6fb3'; g.fillRect(0, 0, 360, 504);
      g.strokeStyle = '#cfe6ff'; g.lineWidth = 8;
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        for (let x = 0; x <= 360; x += 10) g.lineTo(x, 330 + k * 30 + Math.sin(x / 25 + k) * 8);
        g.stroke();
      }
      text(g, strange ? 'みみの湯' : 'みなと湯', 180, 110, 74, '#fff'); // 異変では名前が変わる
      text(g, '朝6時から営業', 180, 200, 30, '#e9f4ff');
      text(g, '駅から徒歩3分', 180, 245, 30, '#e9f4ff');
      break;
    }
    case 'bakery': {
      g.fillStyle = '#f0a43a'; g.fillRect(0, 0, 360, 504);
      g.fillStyle = '#8a4b1a';
      g.beginPath(); g.ellipse(180, 210, 110, 70, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#f7d79a'; g.lineWidth = 6;
      for (let k = -1; k <= 1; k++) {
        g.beginPath(); g.moveTo(150 + k * 45, 160); g.lineTo(200 + k * 45, 260); g.stroke();
      }
      text(g, 'こむぎ堂', 180, 70, 60, '#5a2c0b');
      text(g, '焼きたてを毎朝', 180, 350, 32, '#5a2c0b');
      text(g, '地下1階 西口', 180, 400, 26, '#5a2c0b', 'normal');
      break;
    }
    case 'eye': {
      g.fillStyle = '#f7faf8'; g.fillRect(0, 0, 360, 504);
      g.fillStyle = '#3c9a74'; g.fillRect(0, 430, 360, 74);
      // 目のアイコン
      g.fillStyle = '#fff'; g.strokeStyle = '#2b5f4a'; g.lineWidth = 8;
      g.beginPath(); g.ellipse(180, 200, 120, 62, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = strange ? '#9b0f0f' : '#2b5f4a';
      g.beginPath(); g.arc(180, 200, strange ? 54 : 40, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000';
      g.beginPath(); g.arc(180, 200, strange ? 8 : 18, 0, Math.PI * 2); g.fill();
      if (strange) {
        g.strokeStyle = '#c42020'; g.lineWidth = 2;
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2;
          g.beginPath();
          g.moveTo(180 + Math.cos(a) * 60, 200 + Math.sin(a) * 34);
          g.lineTo(180 + Math.cos(a) * 110, 200 + Math.sin(a) * 56);
          g.stroke();
        }
      }
      text(g, 'ひかり眼科', 180, 70, 54, '#2b5f4a');
      text(g, strange ? '見えていますか' : '見えにくさ、', 180, 320, 34, '#333');
      text(g, strange ? 'ほんとうに' : 'ありませんか', 180, 368, 34, '#333');
      text(g, phone ? '予約 03-1133-315' : '予約 03-0000-0000', 180, 467, 24, '#fff', 'normal');
      break;
    }
    case 'books': {
      g.fillStyle = '#6b4a35'; g.fillRect(0, 0, 360, 504);
      const colors = ['#c9583c', '#3d6e8f', '#d9c27a', '#4f7a4a', '#a0547a'];
      for (let k = 0; k < 7; k++) {
        g.fillStyle = colors[k % colors.length];
        g.fillRect(40 + k * 40, 180 + (k % 3) * 12, 32, 150 - (k % 3) * 12);
      }
      text(g, '夏の', 180, 60, 36, '#f6ead2');
      text(g, '古本まつり', 180, 115, 54, '#f6ead2');
      text(g, '8/1 〜 8/31', 180, 390, 36, '#f6ead2');
      text(g, '地下広場にて', 180, 440, 28, '#f6ead2', 'normal');
      break;
    }
    case 'manner': {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 360, 504);
      g.strokeStyle = '#d33'; g.lineWidth = 14;
      g.beginPath(); g.arc(180, 200, 110, 0, Math.PI * 2); g.stroke();
      // 走る人のピクト（異変: 頭が首から離れて白い目が付き、後ろの腕がだらりと下がる）
      g.fillStyle = '#222';
      g.lineWidth = 16; g.strokeStyle = '#222'; g.lineCap = 'round'; g.lineJoin = 'round';
      if (strange) {
        g.beginPath(); g.arc(166, 112, 21, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(158, 118, 4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(174, 108, 4, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#222';
        g.lineCap = 'butt';
        g.beginPath(); g.moveTo(187, 146); g.lineTo(185, 155); g.stroke(); // 首の切り口
        g.lineCap = 'round';
      } else {
        g.beginPath(); g.arc(195, 130, 18, 0, Math.PI * 2); g.fill();
      }
      g.beginPath(); g.moveTo(185, 155); g.lineTo(170, 220); g.lineTo(130, 270); g.stroke();
      g.beginPath(); g.moveTo(170, 220); g.lineTo(215, 255); g.lineTo(205, 290); g.stroke();
      if (strange) {
        // 後ろの腕はだらりと下がる
        g.beginPath(); g.moveTo(185, 165); g.lineTo(225, 195); g.stroke();
        g.beginPath(); g.moveTo(185, 165); g.lineTo(148, 196); g.lineTo(128, 214); g.stroke();
      } else {
        g.beginPath(); g.moveTo(140, 180); g.lineTo(185, 165); g.lineTo(225, 195); g.stroke();
      }
      g.strokeStyle = '#d33'; g.lineWidth = 14;
      g.beginPath(); g.moveTo(102, 122); g.lineTo(258, 278); g.stroke();
      text(g, '通路では', 180, 380, 38, '#222');
      text(g, '走らないでください', 180, 430, 36, '#222');
      break;
    }
  }
  return toTexture(c);
}

export function shutterTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#8d9192';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#7a7e7f';
  for (let y = 0; y < 256; y += 12) g.fillRect(0, y, 256, 3);
  g.fillStyle = '#e8c63a';
  g.fillRect(48, 108, 160, 46);
  text(g, '通行止め', 128, 132, 30, '#222');
  return toTexture(c);
}

export function hydrantTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 320);
  g.fillStyle = '#c8261f';
  g.fillRect(0, 0, 256, 320);
  g.strokeStyle = '#8e1712'; g.lineWidth = 8; g.strokeRect(10, 10, 236, 300);
  text(g, '消火栓', 128, 90, 48, '#fff');
  g.fillStyle = '#ffd94a';
  g.beginPath(); g.arc(128, 200, 30, 0, Math.PI * 2); g.fill();
  return toTexture(c);
}

/** ドアの表示板「関係者以外立入禁止」 */
export function doorSignTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 160);
  g.fillStyle = '#f4f3ee';
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = '#26476e';
  g.fillRect(0, 0, 512, 8);
  g.fillRect(0, 152, 512, 8);
  text(g, '関係者以外立入禁止', 256, 66, 50, '#26476e');
  text(g, 'STAFF ONLY', 256, 124, 30, '#26476e', 'normal');
  return toTexture(c);
}

/** 足もとの柔らかい陰り（乗算で床に重ねる） */
export function blobTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgb(118,118,118)');
  grd.addColorStop(0.35, 'rgb(160,160,160)');
  grd.addColorStop(0.7, 'rgb(225,225,225)');
  grd.addColorStop(1, 'rgb(255,255,255)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = toTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** 天井スピーカーのグリル */
export function grilleTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#e9e9e5';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#9a9a96';
  for (let y = 10; y < 118; y += 7) {
    for (let x = 10; x < 118; x += 7) {
      if (Math.hypot(x - 64, y - 64) < 50) { g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill(); }
    }
  }
  return toTexture(c);
}
