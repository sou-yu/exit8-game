import * as THREE from 'three';
import * as P from './pbr';

/*
 * 耳タイルマン（異変）。通路の壁と同じ白い施釉タイル（黒っぽい目地の格子）の体をした、細身で裸足の人型。
 * 顔のないのっぺらぼうの頭の両脇に、頭より大きな人間の耳が付いている。
 * 壁に背をつけて直立し、タイル柄に擬態している。近づくと歩き出して追いかけてくる（動きは anomalies.ts）。
 * 体は単純な形を組み合わせて作り、タイル柄は正面から投影する（壁際に立つと、壁の目地とほぼ同じ間隔で並ぶ）。
 */

export interface TileMan {
  /** 足もとが原点で、+z が正面。普段は非表示 */
  group: THREE.Group;
  /** 歩く動き。speed は移動の速さ（m/秒）、0 で直立に戻る */
  animate(dt: number, speed: number): void;
  /** 直立の姿勢に戻す */
  rest(): void;
}

/** 背の高さ約 1.8m。股の高さ・肩の高さ */
const HIP_Y = 0.9, SHOULDER_Y = 1.43;
/** 1 歩（片足）の歩幅（m）。歩く速さから脚を振る速さを決める */
const STRIDE = 0.75;
/** 耳の大きさの倍率（幅 約 0.3m、高さ 約 0.5m。頭の高さは約 0.26m） */
const EAR_SCALE = 1.3;

/** 白いタイル（1m に 7 枚）と黒っぽい目地。壁の施釉タイルと同じ周期 */
function groutTexture(): THREE.CanvasTexture {
  const n = 1024, t = n / 7, gw = 6;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3b3c';
  g.fillRect(0, 0, n, n);
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const k = 222 + ((i * 7 + j * 3) % 5) * 2;
      g.fillStyle = `rgb(${k},${k},${k - 3})`;
      g.fillRect(i * t + gw / 2, j * t + gw / 2, t - gw, t - gw);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function buildTileMan(): TileMan {
  // 凹凸と艶は壁の上のタイルと同じ。色だけ、目地を黒っぽくはっきり描く（壁よりわずかに目地が濃いのが手がかり）
  const set = P.wallGlazedTile();
  const mat = new THREE.MeshStandardMaterial({ ...set, map: groutTexture(), roughness: 1 });
  const group = new THREE.Group();

  /** 部品を置く。タイル柄は直立した姿勢での体の正面（x, y）から投影して貼る */
  const part = (geo: THREE.BufferGeometry, parent: THREE.Object3D, at: THREE.Vector3, origin: THREE.Vector3) => {
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) + origin.x + 0.5;
      uv[i * 2 + 1] = pos.getY(i) + origin.y;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(at);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  /** 体に直接付ける部品（geo は部品の中心が原点） */
  const body = (geo: THREE.BufferGeometry, at: THREE.Vector3) => part(geo, group, at, at);
  const capsule = (r: number, len: number, sx = 1, sz = 1) => new THREE.CapsuleGeometry(r, len, 6, 16).scale(sx, 1, sz);

  // 胴・腰・首・頭（顔はない）
  body(capsule(0.15, 0.4, 1.2, 0.68), v(0, 1.2, 0));
  body(capsule(0.13, 0.1, 1.15, 0.75), v(0, 0.93, 0));
  body(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 14), v(0, 1.53, 0));
  body(new THREE.SphereGeometry(0.105, 24, 18).scale(1, 1.22, 1.08), v(0, 1.67, 0.005));

  // 耳: 頭より大きく、両方で肩幅ほど。外側の縁（耳輪）と、くぼみの縁（対輪）を重ねる
  const earShape = new THREE.Shape();
  earShape.moveTo(0, 0.1);
  earShape.bezierCurveTo(0.02, 0.2, 0.2, 0.22, 0.23, 0.08);
  earShape.bezierCurveTo(0.25, -0.02, 0.16, -0.06, 0.13, -0.12);
  earShape.bezierCurveTo(0.11, -0.18, 0.04, -0.2, 0.02, -0.14);
  earShape.bezierCurveTo(0.0, -0.08, -0.01, 0.02, 0, 0.1);
  const rim = new THREE.CatmullRomCurve3([
    v(0.03, 0.12, 0), v(0.1, 0.18, 0), v(0.2, 0.1, 0), v(0.18, 0.0, 0), v(0.12, -0.08, 0), v(0.08, -0.15, 0),
  ]);
  const anti = new THREE.CatmullRomCurve3([v(0.07, 0.09, 0), v(0.13, 0.08, 0), v(0.13, -0.02, 0), v(0.08, -0.06, 0)]);
  for (const side of [1, -1]) {
    const ear = new THREE.Group();
    ear.position.set(side * 0.085, 1.68, -0.01);
    ear.rotation.y = side * 0.2; // 正面から見て大きく見えるよう、ほぼ前を向ける
    ear.scale.set(side * EAR_SCALE, EAR_SCALE, EAR_SCALE); // 左の耳は右の耳を鏡に映した形
    group.add(ear);
    const o = v(0.085, 1.68, 0);
    const flat = new THREE.ExtrudeGeometry(earShape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 16 });
    part(flat.translate(0, 0, -0.015), ear, v(0, 0, 0), o);
    part(new THREE.TubeGeometry(rim, 40, 0.014, 8).translate(0, 0, 0.022), ear, v(0, 0, 0), o);
    part(new THREE.TubeGeometry(anti, 24, 0.01, 8).translate(0, 0, 0.02), ear, v(0, 0, 0), o);
  }

  // 腕と脚（付け根で回す）。腕は体の横に下ろす
  const limb = (x: number, y: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    group.add(pivot);
    return pivot;
  };
  const arms = [1, -1].map((s) => {
    const sh = limb(s * 0.205, SHOULDER_Y);
    const o = (dy: number) => v(s * 0.205, SHOULDER_Y + dy, 0);
    part(capsule(0.042, 0.26), sh, v(0, -0.16, 0), o(-0.16));
    const el = new THREE.Group();
    el.position.y = -0.31;
    sh.add(el);
    part(capsule(0.036, 0.24), el, v(0, -0.15, 0), o(-0.46));
    part(new THREE.SphereGeometry(0.045, 14, 10).scale(0.6, 1.3, 1), el, v(0, -0.34, 0), o(-0.65));
    return { sh, el };
  });
  const legs = [1, -1].map((s) => {
    const hip = limb(s * 0.085, HIP_Y);
    const o = (dy: number) => v(s * 0.085, HIP_Y + dy, 0);
    part(capsule(0.066, 0.34), hip, v(0, -0.22, 0), o(-0.22));
    const knee = new THREE.Group();
    knee.position.y = -0.44;
    hip.add(knee);
    part(capsule(0.05, 0.34), knee, v(0, -0.21, 0), o(-0.65));
    // 裸足（足の甲と指の付け根を丸めた形）
    part(new THREE.CapsuleGeometry(0.04, 0.14, 4, 12).rotateX(Math.PI / 2).scale(1.05, 0.7, 1), knee, v(0, -0.43, 0.06), o(-0.87));
    return { hip, knee };
  });

  group.visible = false;
  let phase = 0, amp = 0;
  const pose = () => {
    const sw = Math.sin(phase) * amp;
    legs.forEach((l, i) => {
      const s = i ? -sw : sw;
      l.hip.rotation.x = -s * 0.55;
      l.knee.rotation.x = Math.max(0, -Math.cos(phase + (i ? Math.PI : 0))) * amp * 0.7;
    });
    arms.forEach((a, i) => {
      const s = i ? sw : -sw;
      a.sh.rotation.x = -s * 0.45;
      a.el.rotation.x = -amp * 0.35;
    });
  };
  return {
    group,
    animate(dt, speed) {
      amp += ((speed > 0.05 ? 1 : 0) - amp) * (1 - Math.exp(-dt / 0.2));
      phase += (speed * dt / STRIDE) * Math.PI;
      pose();
    },
    rest() {
      phase = amp = 0;
      pose();
    },
  };
}
