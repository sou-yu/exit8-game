import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as T from './textures';
import * as P from './pbr';
import { bakeCeiling, bakeFloor, bakeWalls, type WallProp } from './bake';
import { CEIL_ITEMS, FORWARD_SHIFT, H, LM, LS, ROOMS, W, WALLS } from './layout';
import { Geo, PROFILES, cornerGuards, expansionJoint, extrude, mRange, roomPlane, tactileLayout } from './shell';
import { Lighting, type Lamp } from './lighting';
import { buildShadow, type Man } from './man';
import { buildLeak, type Leak } from './leak';

export { W, H, LS, LM, S_CENTER, FORWARD_SHIFT, canStand } from './layout';
export type { Lamp } from './lighting';
export type { Man } from './man';
import type { Granny } from './granny';

export interface World {
  group: THREE.Group;
  lighting: Lighting;
  lamps: Lamp[];
  /** 環境光（IBL）の強さ 0..1（停電で下げる） */
  envLevel: number;
  mStripeMat: THREE.MeshStandardMaterial;
  /** 判定通路の天井（器具以外の天井の物を含む）。天井が下がる異変で y を動かす */
  mCeiling: THREE.Group;
  mHeaders: THREE.Mesh[];
  hangingSign: THREE.Mesh;
  /** 出口案内の裏の殴り書き（異変、普段は非表示） */
  hangingScrawl: THREE.Mesh;
  hangingBaseY: number;
  posters: { mesh: THREE.Mesh; kind: T.PosterKind }[];
  door: THREE.Object3D; // ヒンジを軸に回す
  doorVoid: THREE.Mesh;
  signs: { aEast: THREE.Mesh; aWest: THREE.Mesh; bEast: THREE.Mesh; bWest: THREE.Mesh };
  man: Man;
  shadow: THREE.Group;
  /** 換気口から赤い液体が垂れる異変の小道具（普段は非表示） */
  leak: Leak;
  /** 振り向くとすぐ後ろに立っているおばあさん（異変、普段は非表示） */
  granny: Granny;
}

/** 壁の向き: 法線 (nx, nz) を向く物を (x, y, z) に置く */
function placeOnWall(o: THREE.Object3D, x: number, y: number, z: number, nx: number, nz: number, off = 0.01) {
  o.position.set(x + nx * off, y, z + nz * off);
  o.rotation.y = Math.atan2(nx, nz);
}

/** 焼き込みアトラス（uv1）を材質に効かせる: R=陰り G=明るさ B=粗さ A=黄ばみ */
function macro<M extends THREE.MeshStandardMaterial>(m: M, atlas: THREE.Texture, key: string): M {
  m.aoMap = atlas;
  m.aoMapIntensity = 1;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 macroS = texture2D( aoMap, vAoMapUv );
        diffuseColor.rgb *= macroS.g * 2.0;
        diffuseColor.rgb *= 1.0 - macroS.a * vec3( 0.0, 0.05, 0.15 );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp( roughnessFactor + ( macroS.b - 0.5 ), 0.03, 1.0 );`)
      // 直接光にも陰りを半分ほど効かせる（隅・額縁の下などの接触影）
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.directDiffuse *= mix( 1.0, macroS.r, 0.55 );
        reflectedLight.directSpecular *= mix( 1.0, macroS.r, 0.55 );`);
  };
  m.customProgramCacheKey = () => 'macro-' + key;
  return m;
}

/** PBRセットの uv の周期（m）を指定する */
function scaled(set: P.PBRSet, pu: number, pv: number, ov = 0): P.PBRSet {
  for (const t of [set.map, set.normalMap, set.roughnessMap]) {
    t.repeat.set(1 / pu, 1 / pv);
    t.offset.set(0, -ov / pv);
  }
  return set;
}

// ---- 壁の取り付け物（焼き込みの陰りにも使う） ----
const POSTER_KINDS: T.PosterKind[] = ['bath', 'bakery', 'eye', 'books', 'manner'];
const POSTER_Z = POSTER_KINDS.map((_, i) => -8 - i * 3.5);
const DOOR_Z = [-11, -21];
const VENT_Z = [-16, -6];
const HYDRANT_Z = -25.5;
const SIGN_SPOTS: [number, number, number, number][] = [ // x, z, nx, nz
  [LS, W / 2, -1, 0], [0, W / 2, 1, 0], [2 * LS - W, -LM - W / 2, -1, 0], [LS - W, -LM - W / 2, 1, 0],
];
/** 案内板の中心の高さ。下端が壁の帯（1.12m まで）にかからない位置 */
const GUIDE_Y = 1.74;
const GUIDE_SPOTS: [number, number, number][] = [ // x, z, nz
  [LS / 2, W, -1], [LS / 2, 0, 1], [LS / 2 - FORWARD_SHIFT.x, W - FORWARD_SHIFT.y, -1], [LS / 2 - FORWARD_SHIFT.x, -FORWARD_SHIFT.y, 1],
];

function wallProps(): WallProp[] {
  const p: WallProp[] = [];
  POSTER_Z.forEach((z) => p.push({ x: LS - W, y: 1.5, z, n: [1, 0], w: 1.07, h: 1.47, d: 0.028 }));
  DOOR_Z.forEach((z) => p.push({ x: LS, y: 1.08, z, n: [-1, 0], w: 1.06, h: 2.16, d: 0.045 }));
  VENT_Z.forEach((z) => p.push({ x: LS, y: 2.35, z, n: [-1, 0], w: 0.62, h: 0.47, d: 0.03 }));
  p.push({ x: LS, y: 0.95, z: HYDRANT_Z, n: [-1, 0], w: 0.7, h: 0.9, d: 0.12 });
  SIGN_SPOTS.forEach(([x, z, nx, nz]) => p.push({ x, y: 1.65, z, n: [nx, nz], w: 1.1, h: 0.82, d: 0.014 }));
  GUIDE_SPOTS.forEach(([x, z, nz]) => p.push({ x, y: GUIDE_Y, z, n: [0, nz], w: 1.62, h: 1.14, d: 0.014 }));
  return p;
}

export function buildWorld(man: Man, granny: Granny): World {
  const group = new THREE.Group();

  // ================= 外殻 =================
  const wallAtlas = bakeWalls(wallProps());
  const floorAtlas = bakeFloor();
  const ceilAtlas = bakeCeiling();

  const upperSet = P.wallGlazedTile();
  const paintMat = macro(new THREE.MeshStandardMaterial({ ...scaled(upperSet, 1, 1, 1.12), roughness: 1 }), wallAtlas.tex, 'paint');
  const tileMat = macro(new THREE.MeshStandardMaterial({ ...scaled(P.wallTile(), 1, 0.9, 0.1), roughness: 1 }), wallAtlas.tex, 'tile');
  const bandSet = scaled(P.bandTile(), 1, 0.118, 0.996);
  const stripeMat = macro(new THREE.MeshStandardMaterial({ ...bandSet, color: 0x2a7d63, roughness: 1 }), wallAtlas.tex, 'band');
  const mStripeMat = macro(new THREE.MeshStandardMaterial({ ...bandSet, color: 0x2a7d63, roughness: 1 }), wallAtlas.tex, 'band');
  const skirtMat = macro(new THREE.MeshStandardMaterial({ ...scaled(P.skirting(), 1, 0.1), roughness: 1 }), wallAtlas.tex, 'skirt');
  const alu = P.satinAluminium();
  const corniceMat = macro(new THREE.MeshStandardMaterial({ ...scaled(alu, 0.2, 0.2), roughness: 1, metalness: 1 }), wallAtlas.tex, 'cornice');
  const floorMat = macro(new THREE.MeshStandardMaterial({ ...P.floorTile(), roughness: 1 }), floorAtlas.tex, 'floor');
  const ceilSet = P.ceilingBoard();
  const ceilMat = macro(new THREE.MeshStandardMaterial({ ...ceilSet, roughness: 1 }), ceilAtlas.tex, 'ceil');

  const gPaint = new Geo(), gTile = new Geo(), gBand = new Geo(), gBandM = new Geo(), gSkirt = new Geo(), gCornice = new Geo();
  WALLS.forEach((w, si) => {
    if (w.shutter) return;
    extrude(gSkirt, si, w, PROFILES.skirting, wallAtlas);
    extrude(gTile, si, w, PROFILES.wainscot, wallAtlas);
    extrude(gPaint, si, w, PROFILES.paint, wallAtlas);
    extrude(gCornice, si, w, PROFILES.cornice, wallAtlas);
    const mr = mRange(w);
    if (!mr) extrude(gBand, si, w, PROFILES.band, wallAtlas);
    else {
      extrude(gBandM, si, w, PROFILES.band, wallAtlas, mr);
      if (mr[0] > 1e-6) extrude(gBand, si, w, PROFILES.band, wallAtlas, [0, mr[0]]);
      if (mr[1] < w.len - 1e-6) extrude(gBand, si, w, PROFILES.band, wallAtlas, [mr[1], w.len]);
    }
  });
  const shellMesh = (g: Geo, m: THREE.Material) => {
    const mesh = new THREE.Mesh(g.build(), m);
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  shellMesh(gSkirt, skirtMat);
  shellMesh(gTile, tileMat);
  shellMesh(gPaint, paintMat);
  shellMesh(gCornice, corniceMat);
  shellMesh(gBand, stripeMat);
  shellMesh(gBandM, mStripeMat);

  // シャッター（後方通路の突き当たり）
  const sh = WALLS[WALLS.length - 1];
  const slats = P.shutterSlats();
  slats.normalMap.repeat.set(1, H / 0.08);
  slats.roughnessMap.repeat.set(1, H / 0.08);
  const shutter = new THREE.Mesh(new THREE.PlaneGeometry(sh.len, H), new THREE.MeshStandardMaterial({
    map: T.shutterTexture(), ...slats, roughness: 1, metalness: 0.55,
  }));
  placeOnWall(shutter, (sh.a[0] + sh.b[0]) / 2, H / 2, (sh.a[1] + sh.b[1]) / 2, sh.n[0], sh.n[1], 0.02);
  shutter.receiveShadow = true;
  group.add(shutter);

  // 床・天井（判定通路の天井は異変で動かすので別にする）
  const gFloor = new Geo(), gCeil = new Geo(), gCeilM = new Geo();
  ROOMS.forEach((r, i) => {
    roomPlane(gFloor, i, 0, false, floorAtlas);
    roomPlane(r.isM ? gCeilM : gCeil, i, H, true, ceilAtlas);
  });
  shellMesh(gFloor, floorMat);
  const ceilMesh = new THREE.Mesh(gCeil.build(), ceilMat);
  group.add(ceilMesh);
  const mCeiling = new THREE.Group();
  mCeiling.add(new THREE.Mesh(gCeilM.build(), ceilMat));
  group.add(mCeiling);

  // 天井が下がる異変用の「段差」の壁（普段は非表示）
  const headerSet = P.wallGlazedTile();
  for (const tex of [headerSet.map, headerSet.normalMap, headerSet.roughnessMap]) tex.repeat.set(W, 0.6);
  const headerMat = new THREE.MeshStandardMaterial({ ...headerSet, roughness: 1 });
  const mHeaders: THREE.Mesh[] = [];
  for (const [z, nz] of [[0, 1], [-LM, -1]] as const) {
    const hm = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.6), headerMat);
    placeOnWall(hm, LS - W / 2, H - 0.3, z, 0, nz, 0);
    hm.visible = false;
    group.add(hm);
    mHeaders.push(hm);
  }

  // 出隅のコーナーガードと、伸縮目地のカバー
  const steel = P.brushedSteel();
  const steelPlain = new THREE.MeshStandardMaterial({ color: 0xc4c6c7, roughness: 0.38, metalness: 1 });
  // コーナーガードはヘアラインを縦に流し、手の触れる高さの擦れ・くすみも粗さで出す（幅45mm × 高さ2.67m）
  const vertical = (t: THREE.Texture) => {
    const c = t.clone();
    c.center.set(0.5, 0.5);
    c.rotation = Math.PI / 2;
    c.repeat.set(2.665 / 0.25, 0.045 / 0.25);
    return c;
  };
  const guardMat = new THREE.MeshStandardMaterial({
    color: 0xc4c6c7, roughness: 1, metalness: 1, normalMap: vertical(steel.normalMap), roughnessMap: vertical(steel.roughnessMap),
  });
  const guards = new THREE.Mesh(mergeGeometries(cornerGuards()), guardMat);
  guards.receiveShadow = true;
  group.add(guards);
  const ej = expansionJoint();
  const joint = new THREE.Mesh(ej.floor, new THREE.MeshStandardMaterial({ color: 0xb4b7b8, roughness: 0.42, metalness: 1 }));
  joint.receiveShadow = true;
  group.add(joint);
  mCeiling.add(new THREE.Mesh(ej.ceiling, new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.5, metalness: 0.6 })));

  // 点字ブロック（333mm 角の板を並べる）
  const tl = tactileLayout();
  const tilePlane = new THREE.PlaneGeometry(1 / 3 - 0.004, 1 / 3 - 0.004);
  const tColor = new THREE.Color();
  for (const [kind, mats, keys] of [['line', tl.line, tl.lineKeys], ['dot', tl.dot, tl.dotKeys]] as const) {
    const set = P.tactile(kind);
    const im = new THREE.InstancedMesh(tilePlane, new THREE.MeshStandardMaterial({ ...set, roughness: 1 }), mats.length);
    mats.forEach((m, i) => {
      im.setMatrixAt(i, m);
      const k = keys[i];
      im.setColorAt(i, tColor.setRGB(0.94 + k * 0.08, 0.94 + k * 0.07, 0.92 + k * 0.06));
    });
    im.receiveShadow = true;
    group.add(im);
  }

  // ================= 照明 =================
  const lighting = new Lighting(mCeiling);
  lighting.patchCeiling(ceilMat);
  group.add(lighting.group);

  // 天井の小物（煙感知器・スプリンクラー・スピーカー）
  const white = new THREE.MeshStandardMaterial({ color: 0xf0efea, roughness: 0.45 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe2e2e2, roughness: 0.18, metalness: 1 });
  const grille = new THREE.MeshStandardMaterial({ map: T.grilleTexture(), roughness: 0.6 });
  const smokeGeo = new THREE.CylinderGeometry(0.05, 0.055, 0.035, 24);
  const sprGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.03, 0.03, 0.006, 20).translate(0, -0.003, 0),
    new THREE.CylinderGeometry(0.007, 0.01, 0.03, 10).translate(0, -0.018, 0),
    new THREE.CylinderGeometry(0.016, 0.016, 0.002, 14).translate(0, -0.035, 0),
  ]);
  const spkGeo = new THREE.CylinderGeometry(0.11, 0.115, 0.014, 32);
  for (const inMGroup of [false, true]) {
    const items = CEIL_ITEMS.filter((c) => c.inM === inMGroup);
    const parent = inMGroup ? mCeiling : group;
    const mk = (kind: string, geo: THREE.BufferGeometry, mat: THREE.Material, y: number, rotX = 0) => {
      const list = items.filter((c) => c.kind === kind);
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      list.forEach((c, i) => im.setMatrixAt(i, m.makeRotationX(rotX).setPosition(c.x, y, c.z)));
      parent.add(im);
    };
    mk('smoke', smokeGeo, white, H - 0.0175);
    mk('sprinkler', sprGeo, chrome, H);
    mk('speaker', spkGeo, white, H - 0.007);
    const spk = items.filter((c) => c.kind === 'speaker');
    spk.forEach((c) => {
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.1, 32), grille);
      face.rotation.x = Math.PI / 2;
      face.position.set(c.x, H - 0.0145, c.z);
      parent.add(face);
    });
  }

  // ================= 案内・広告 =================
  // 出口案内（天井から下げる内照式。表は乳白アクリル、縁はアルミ）
  const aluMat = new THREE.MeshStandardMaterial({ color: 0xa9adaf, roughness: 0.34, metalness: 1, normalMap: alu.normalMap });
  const signFace = () => {
    const t = T.hangingSignTexture('normal');
    return new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.7, roughness: 0.14 });
  };
  const hangingSign = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.45, 0.07),
    [0, 0, 0, 0, 1, 0].map((i) => (i ? signFace() : aluMat)),
  );
  const hangingBaseY = H - 0.45;
  hangingSign.position.set(LS - W / 2, hangingBaseY, -6);
  hangingSign.castShadow = true;
  const rim = new THREE.Mesh(new RoundedBoxGeometry(2.44, 0.49, 0.05, 2, 0.012), aluMat);
  rim.position.z = -0.012;
  hangingSign.add(rim);
  for (const dx of [-0.9, 0.9]) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.23, 8), steelPlain);
    rod.position.set(dx, 0.34, 0);
    hangingSign.add(rod);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.008, 16), steelPlain);
    plate.position.set(dx, 0.446, 0);
    hangingSign.add(plate);
  }
  // 裏面（縁のアルミの裏）に貼る殴り書き
  const hangingScrawl = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.43), new THREE.MeshStandardMaterial({
    map: T.scrawlTexture(), transparent: true, depthWrite: false, roughness: 0.45, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  hangingScrawl.rotation.y = Math.PI;
  hangingScrawl.position.z = -0.0375;
  hangingScrawl.visible = false;
  hangingSign.add(hangingScrawl);
  group.add(hangingSign);

  // 待合のきまり看板（ラミネートした印刷物をアルミの板に貼ったもの）
  const guideTex = T.guideTexture();
  const lam = P.laminate();
  const guideMat = new THREE.MeshStandardMaterial({ map: guideTex, ...lam, roughness: 1 });
  GUIDE_SPOTS.forEach(([x, z, nz]) => {
    const board = new THREE.Mesh(new RoundedBoxGeometry(1.64, 1.16, 0.012, 2, 0.004), aluMat);
    placeOnWall(board, x, GUIDE_Y, z, 0, nz, 0.006);
    board.receiveShadow = true;
    group.add(board);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.12), guideMat);
    m.receiveShadow = true;
    placeOnWall(m, x, GUIDE_Y, z, 0, nz, 0.0125);
    group.add(m);
  });

  // 番号看板（ホーロー: 艶のある焼き付け）
  const enamel = P.enamel();
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xe9ece8, roughness: 0.2 });
  const signGeo = new THREE.PlaneGeometry(1.1, 0.82);
  const screwGeo = new THREE.SphereGeometry(0.008, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const mkSign = (x: number, z: number, nx: number) => {
    const plate = new THREE.Mesh(new RoundedBoxGeometry(1.11, 0.83, 0.008, 2, 0.004), plateMat);
    placeOnWall(plate, x, 1.65, z, nx, 0, 0.01);
    group.add(plate);
    const m = new THREE.Mesh(signGeo, new THREE.MeshStandardMaterial({ map: T.numberSignTexture(0), ...enamel, roughness: 1 }));
    m.receiveShadow = true;
    placeOnWall(m, x, 1.65, z, nx, 0, 0.0145);
    group.add(m);
    for (const [sx, sy] of [[-0.51, 0.37], [0.51, 0.37], [-0.51, -0.37], [0.51, -0.37]]) {
      const s = new THREE.Mesh(screwGeo, chrome);
      s.rotation.x = Math.PI / 2;
      s.position.set(sx, sy, 0.001);
      m.add(s);
    }
    return m;
  };
  const signs = {
    aEast: mkSign(...(SIGN_SPOTS[0].slice(0, 3) as [number, number, number])),
    aWest: mkSign(...(SIGN_SPOTS[1].slice(0, 3) as [number, number, number])),
    bEast: mkSign(...(SIGN_SPOTS[2].slice(0, 3) as [number, number, number])),
    bWest: mkSign(...(SIGN_SPOTS[3].slice(0, 3) as [number, number, number])),
  };

  // 広告ポスター（判定通路の西側の壁）: アルミのスナップフレーム、紙の印刷物を透明アクリルが覆う
  const acrylic = P.acrylicCover();
  const backMat = new THREE.MeshStandardMaterial({ color: 0x2c2d2e, roughness: 0.7 });
  const posters = POSTER_KINDS.map((kind, i) => {
    const z = POSTER_Z[i];
    const frame = new THREE.Group();
    const fGeo = mergeGeometries([
      new RoundedBoxGeometry(0.024, 1.46, 0.035, 2, 0.006).translate(0, 0, 0.5125),
      new RoundedBoxGeometry(0.024, 1.46, 0.035, 2, 0.006).translate(0, 0, -0.5125),
      new RoundedBoxGeometry(0.024, 0.035, 1.06, 2, 0.006).translate(0, 0.7125, 0),
      new RoundedBoxGeometry(0.024, 0.035, 1.06, 2, 0.006).translate(0, -0.7125, 0),
    ]);
    const fm = new THREE.Mesh(fGeo, aluMat);
    fm.castShadow = true;
    fm.receiveShadow = true;
    frame.add(fm);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.01, 1.43, 1.03), backMat);
    back.position.x = -0.006;
    frame.add(back);
    frame.position.set(LS - W + 0.012, 1.5, z);
    group.add(frame);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.4), new THREE.MeshStandardMaterial({
      map: T.posterTexture(kind), ...acrylic, roughness: 1,
    }));
    m.receiveShadow = true;
    placeOnWall(m, LS - W, 1.5, z, 1, 0, 0.021);
    group.add(m);
    return { mesh: m, kind };
  });

  // ドア（判定通路の東側の壁）: 塗装鋼板の扉、アルミの枠、レバーハンドル、ステンレスの蹴板、表示板
  const doorSet = P.paintedSteel(0x7f8784);
  const doorMat = new THREE.MeshStandardMaterial({ ...doorSet, roughness: 1, metalness: 0.2 });
  const frameMat = new THREE.MeshStandardMaterial({ ...P.paintedSteel(0x6f7472, 0.6), roughness: 1, metalness: 0.3 });
  const kickMat = new THREE.MeshStandardMaterial({ color: 0xc6c8c9, roughness: 0.3, metalness: 1, normalMap: steel.normalMap, roughnessMap: steel.roughnessMap });
  const doorSignMat = new THREE.MeshStandardMaterial({ map: T.doorSignTexture(), roughness: 0.3 });
  let door!: THREE.Object3D;
  let doorVoid!: THREE.Mesh;
  DOOR_Z.forEach((z, i) => {
    const fr = new THREE.Group();
    const jamb = (dz: number) => {
      const j = new THREE.Mesh(new RoundedBoxGeometry(0.06, 2.16, 0.07, 2, 0.008), frameMat);
      j.position.set(0, 1.08, dz);
      fr.add(j);
    };
    jamb(0.495); jamb(-0.495);
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.07, 1.06, 2, 0.008), frameMat);
    head.position.set(0, 2.125, 0);
    fr.add(head);
    fr.position.set(LS - 0.03, 0, z);
    fr.traverse((o) => { o.receiveShadow = true; o.castShadow = true; });
    group.add(fr);
    const voidM = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 2.09), new THREE.MeshBasicMaterial({ color: 0x080808 }));
    placeOnWall(voidM, LS, 1.045, z, -1, 0, 0.03);
    group.add(voidM);
    const pivot = new THREE.Object3D();
    pivot.position.set(LS - 0.03, 0, z + 0.455); // ヒンジ側
    const panel = new THREE.Mesh(new RoundedBoxGeometry(0.042, 2.07, 0.9, 2, 0.006), doorMat);
    panel.castShadow = true;
    panel.receiveShadow = true;
    panel.position.set(0, 1.045, -0.455);
    pivot.add(panel);
    const kick = new THREE.Mesh(new RoundedBoxGeometry(0.003, 0.24, 0.84, 1, 0.001), kickMat);
    kick.position.set(-0.0225, 0.15, -0.455);
    pivot.add(kick);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.106), doorSignMat);
    plate.rotation.y = -Math.PI / 2;
    plate.position.set(-0.0222, 1.6, -0.455);
    pivot.add(plate);
    // レバーハンドル
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 20), chrome);
    rose.rotation.z = Math.PI / 2;
    rose.position.set(-0.027, 1.0, -0.8);
    pivot.add(rose);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.055, 12), chrome);
    neck.rotation.z = Math.PI / 2;
    neck.position.set(-0.055, 1.0, -0.8);
    pivot.add(neck);
    const lever = new THREE.Mesh(new RoundedBoxGeometry(0.018, 0.018, 0.13, 2, 0.008), chrome);
    lever.position.set(-0.08, 1.0, -0.745);
    lever.castShadow = true;
    pivot.add(lever);
    for (const hy of [0.25, 1.05, 1.85]) {
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 10), steelPlain);
      hinge.position.set(-0.02, hy, 0.0);
      pivot.add(hinge);
    }
    group.add(pivot);
    if (i === 0) { door = pivot; doorVoid = voidM; }
  });

  // 消火栓（赤い位置表示灯は常に点いている）
  const redSet = P.paintedSteel(0xa8231b);
  const redPaint = new THREE.MeshStandardMaterial({ ...redSet, roughness: 1, metalness: 0.15 });
  const hyd = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.9, 0.7, 2, 0.012), redPaint);
  hyd.position.set(LS - 0.06, 0.95, HYDRANT_Z);
  hyd.castShadow = true;
  hyd.receiveShadow = true;
  group.add(hyd);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.7), new THREE.MeshStandardMaterial({
    map: T.hydrantTexture(), normalMap: redSet.normalMap, roughness: 0.36, metalness: 0.1,
  }));
  placeOnWall(label, LS - 0.12, 0.92, HYDRANT_Z, -1, 0, 0.0012);
  group.add(label);
  const lampRed = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({
    color: 0x4a0a08, emissive: 0xff2a1a, emissiveIntensity: 2, roughness: 0.2,
  }));
  lampRed.rotation.z = Math.PI / 2;
  lampRed.position.set(LS - 0.004, 1.55, HYDRANT_Z);
  group.add(lampRed);
  const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 20), redPaint);
  lampBase.rotation.z = Math.PI / 2;
  lampBase.position.set(LS - 0.006, 1.55, HYDRANT_Z);
  group.add(lampBase);

  // 換気口
  const ventSet = P.vent();
  const ventMat = new THREE.MeshStandardMaterial({ ...ventSet, roughness: 1, metalness: 0.5 });
  VENT_Z.forEach((z) => {
    const v = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.47, 0.62, 2, 0.006), ventMat);
    v.castShadow = true;
    v.position.set(LS - 0.015, 2.35, z);
    group.add(v);
  });

  const leak = buildLeak(LS, VENT_Z[0]);
  group.add(leak.group);

  group.add(man.group);
  const shadow = buildShadow(man);
  group.add(shadow);
  group.add(granny.group);

  return {
    group, lighting, lamps: lighting.lamps, envLevel: 1, mStripeMat, mCeiling, mHeaders, hangingSign, hangingBaseY,
    posters, door, doorVoid, signs, man, shadow, leak, hangingScrawl, granny,
  };
}
