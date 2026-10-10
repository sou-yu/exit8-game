import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CEIL_ITEMS, FIXTURE, H, LAMP_SPOTS, type LampSpot } from './layout';
import * as P from './pbr';

/*
 * 蛍光灯（直付けの乳白カバー付き器具）と照明。
 * - カメラに近い器具は面光源（RectAreaLight）、離れた器具は下向きのスポットライトで近似する。
 *   面光源はシェーダーが重く、全器具分を持つと Windows の GPU でシェーダーの準備が終わらなくなるため数を絞る。
 *   距離でなめらかに受け持ちを移すので、切り替わりで明るさは変わらない。カバーの発光面と同じ輝度・色にそろえる
 * - 色温度・明るさ・カバーの黄ばみ・管端の黒ずみに個体差を付ける（ループで重なる器具どうしは同じ個体）
 * - 面光源は影を落とせないので、カメラに近い器具だけ光の一部を影付きスポットライトに分けて受け持たせる
 *   （距離でなめらかに配分を変えるので、受け持ちが替わっても明るさは変わらない）
 * - 停電時は、影付きスポットを非常灯の位置へ回す
 */

RectAreaLightUniformsLib.init();

/*
 * 面光源の計算は重いので、遠い器具（18m 以上）の分は省く。12〜18m でなめらかに弱めて境目を見せない。
 * この距離では器具の寄与は1%未満なので、見た目はほとんど変わらない。
 */
const RECT_FADE: [number, number] = [12, 18];
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(
  'rectAreaLight = rectAreaLights[ i ];\n\t\tRE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
  // ループは展開されるので、ここでは変数を宣言しない
  `rectAreaLight = rectAreaLights[ i ];
\t\tif ( distance( rectAreaLight.position, geometryPosition ) < ${RECT_FADE[1].toFixed(1)} ) {
\t\t\trectAreaLight.color *= 1.0 - smoothstep( ${RECT_FADE[0].toFixed(1)}, ${RECT_FADE[1].toFixed(1)}, distance( rectAreaLight.position, geometryPosition ) );
\t\t\tRE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
\t\t}`,
);
if (!THREE.ShaderChunk.lights_fragment_begin.includes('smoothstep( 12.0')) console.warn('rect light range patch not applied');

/** カバー面の輝度（シーン単位）。照明の基準の明るさ */
export const LAMP_LUM = 15;
const COVER_AREA = FIXTURE.coverLen * FIXTURE.coverW;
/** 影付きスポットが受け持つ割合 */
const SHADOW_SHARE = 0.6;
const EM_INTENSITY = 1.6; // 非常灯（cd）
/**
 * 乳白カバーの側面から横へ漏れる光の割合。器具のまわりの天井だけがほんのり明るくなる
 * （面光源は下向きの片面なので、この光は天井の材質で近似する）
 */
const SIDE_GLOW = 0.065;
const EM_COLOR = new THREE.Color(1.0, 0.93, 0.84);

interface Variant {
  color: THREE.Color;
  gain: number;
  /** x: 黒ずみの位置(-1..1) y: 黒ずみの強さ z: カバーの黄ばみ w: 2本の管の明るさの差 */
  age: THREE.Vector4;
}

/**
 * カメラのホワイトバランスを管の色温度より少し低めに合わせた状態（白い壁がわずかに青白く写る）。
 * 管どうしの色の差はそのまま残る。
 */
const WB = [0.95, 1.0, 1.06];
const kelvin = (r: number, g: number, b: number) => {
  const c = new THREE.Color(r * WB[0], g * WB[1], b * WB[2]);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return c.multiplyScalar(1 / l);
};
// 昼白色を基本に、少し青白い管・少し黄ばんだ古い管が混じっている
const VARIANTS: Variant[] = [
  { color: kelvin(1.0, 0.985, 0.95), gain: 1.0, age: new THREE.Vector4(0.74, 0.55, 0.08, 0.1) },
  { color: kelvin(0.95, 0.985, 1.0), gain: 1.04, age: new THREE.Vector4(0, 0, 0.03, -0.18) },
  { color: kelvin(1.0, 0.94, 0.83), gain: 0.9, age: new THREE.Vector4(-0.8, 0.4, 0.4, 0.12) },
  { color: kelvin(1.0, 0.975, 0.93), gain: 0.97, age: new THREE.Vector4(0, 0, 0.15, 0) },
  { color: kelvin(0.97, 0.985, 1.0), gain: 1.0, age: new THREE.Vector4(0, 0, 0.06, 0.06) },
];

export interface Lamp {
  spot: LampSpot;
  inM: boolean;
  /** 0..1 明るさ（異変で変える） */
  level: number;
  /** 器具があるか（異変で消す） */
  visible: boolean;
  /** 天井の上下（異変で下げる） */
  yOffset: number;
}

export interface LightPreset {
  /** カメラに近い器具から何灯を面光源にするか（0 ならすべてスポットライトで近似） */
  rects: number;
  shadows: number;
  shadowSize: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function makeSpot(): THREE.SpotLight {
  const l = new THREE.SpotLight(0xffffff, 0, 0, 1.53, 1, 2);
  return l;
}

interface Emitter { x: number; z: number; y: number; w: number; isLamp: boolean; idx: number }

export class Lighting {
  readonly group = new THREE.Group();
  readonly lamps: Lamp[];
  /** 非常灯の点灯 0..1 */
  emergency = 0;
  private bodies: THREE.InstancedMesh;
  private covers: THREE.InstancedMesh;
  private coverMat: THREE.MeshStandardMaterial;
  private emLens: THREE.InstancedMesh;
  private emUnits: { x: number; z: number; inM: boolean }[];
  private rects: THREE.RectAreaLight[] = [];
  private fills: THREE.SpotLight[] = [];
  private slots: THREE.SpotLight[] = [];
  private preset: LightPreset = { rects: 0, shadows: 0, shadowSize: 1024 };
  private rectCand: { i: number; w: number }[] = [];
  private emissiveOn = true;
  private sig = '';
  private emitters: Emitter[] = [];
  private mGroup: THREE.Object3D;

  constructor(mCeiling: THREE.Object3D) {
    this.mGroup = mCeiling;
    this.lamps = LAMP_SPOTS.map((spot) => ({ spot, inM: spot.inM, level: 1, visible: true, yOffset: 0 }));
    const n = this.lamps.length;

    // 器具本体（白い焼付塗装の鋼板）
    const bodyMat = new THREE.MeshStandardMaterial({ ...P.paintedSteel(0xf1f0ea, 0.4), roughness: 1, metalness: 0 });
    this.bodies = new THREE.InstancedMesh(new RoundedBoxGeometry(FIXTURE.len, FIXTURE.h, FIXTURE.w, 2, 0.008), bodyMat, n);
    // 乳白アクリルのカバー: 2本の管の位置が少し明るく、両端は暗い
    this.coverMat = new THREE.MeshStandardMaterial({
      color: 0xf2f1ec, roughness: 0.35, emissive: 0xffffff, emissiveIntensity: LAMP_LUM / 0.78,
    });
    const coverGeo = new RoundedBoxGeometry(FIXTURE.coverLen, FIXTURE.coverH, FIXTURE.coverW, 3, 0.012);
    const age = new Float32Array(n * 4);
    this.lamps.forEach((l, i) => VARIANTS[l.spot.variant].age.toArray(age, i * 4));
    coverGeo.setAttribute('aAge', new THREE.InstancedBufferAttribute(age, 4));
    this.covers = new THREE.InstancedMesh(coverGeo, this.coverMat, n);
    this.covers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const hl = (FIXTURE.coverLen / 2).toFixed(4), hw = (FIXTURE.coverW / 2).toFixed(4);
    this.coverMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aAge;\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying vec4 vAge;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;\nvLocalN = normal;\nvAge = aAge;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;\nvarying vec3 vLocalN;\nvarying vec4 vAge;')
        // 個体ごとの色は発光だけに使う（消灯時のカバーは乳白色のまま）
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= 1.0 - vAge.z * vec3( 0.0, 0.07, 0.22 );')
        .replace('#include <emissivemap_fragment>', `
          float along = vLocal.x / ${hl};
          float across = vLocal.z / ${hw};
          float tubeA = exp( -pow( ( across - 0.46 ) / 0.4, 2.0 ) );
          float tubeB = exp( -pow( ( across + 0.46 ) / 0.4, 2.0 ) );
          float bands = 0.6 + 0.4 * ( tubeA * ( 1.0 + vAge.w ) + tubeB * ( 1.0 - vAge.w ) );
          float ends = 0.4 + 0.6 * smoothstep( 1.0, 0.86, abs( along ) );
          float dark = 1.0 - vAge.y * exp( -pow( ( along - vAge.x ) / 0.07, 2.0 ) );
          float face = mix( 0.55, 1.0, smoothstep( 0.0, -0.8, vLocalN.y ) );
          vec3 yellow = 1.0 - vAge.z * vec3( 0.0, 0.05, 0.16 );
          totalEmissiveRadiance *= vColor.rgb * yellow * bands * ends * dark * face;
        `);
    };
    this.covers.castShadow = false;
    this.bodies.castShadow = false;
    this.bodies.receiveShadow = false;
    this.group.add(this.bodies, this.covers);

    // 非常灯（ふだんは消えている。小さな緑の充電ランプだけ点く）
    this.emUnits = CEIL_ITEMS.filter((c) => c.kind === 'emergency').map((c) => ({ x: c.x, z: c.z, inM: c.inM }));
    const emBodyMat = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.4 });
    const emBody = new THREE.InstancedMesh(new RoundedBoxGeometry(0.22, 0.05, 0.13, 2, 0.01), emBodyMat, this.emUnits.length);
    const lensMat = new THREE.MeshStandardMaterial({ color: 0xf6f6f4, roughness: 0.2, emissive: 0xffffff, emissiveIntensity: 1 });
    lensMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <color_fragment>', '')
        .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= vColor.rgb;');
    };
    this.emLens = new THREE.InstancedMesh(new THREE.SphereGeometry(0.032, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), lensMat, this.emUnits.length);
    this.emLens.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.emUnits.length * 3), 3);
    const ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.2, 0.5) });
    const led = new THREE.InstancedMesh(new THREE.SphereGeometry(0.004, 6, 4), ledMat, this.emUnits.length);
    this.emUnits.forEach((u, i) => {
      emBody.setMatrixAt(i, _m.makeTranslation(u.x, H - 0.025, u.z));
      this.emLens.setMatrixAt(i, _m.makeTranslation(u.x + 0.04, H - 0.05, u.z));
      led.setMatrixAt(i, _m.makeTranslation(u.x - 0.07, H - 0.05, u.z + 0.03));
    });
    this.group.add(emBody, this.emLens, led);
    this.emBody = emBody;
    this.emLed = led;

    this.glowPos = this.lamps.map((l) => new THREE.Vector4(l.spot.x, l.spot.z, l.spot.alongX ? 1 : 0, l.spot.alongX ? 0 : 1));
    this.glowCol = this.lamps.map(() => new THREE.Vector3());
    this.syncInstances(true);
  }

  private emBody: THREE.InstancedMesh;
  private emLed: THREE.InstancedMesh;
  private glowPos: THREE.Vector4[];
  private glowCol: THREE.Vector3[];

  /** 天井の材質に、器具の側面から漏れる光を足す（器具の点灯状態に合わせて変わる） */
  patchCeiling(m: THREE.MeshStandardMaterial) {
    const base = m.onBeforeCompile;
    const n = this.lamps.length;
    const hl = (FIXTURE.len / 2).toFixed(4), hw = (FIXTURE.w / 2).toFixed(4);
    m.onBeforeCompile = (sh, r) => {
      base.call(m, sh, r);
      sh.uniforms.uLampPos = { value: this.glowPos };
      sh.uniforms.uLampCol = { value: this.glowCol };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGlowPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlowPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vGlowPos;
          uniform vec4 uLampPos[ ${n} ];
          uniform vec3 uLampCol[ ${n} ];`)
        .replace('#include <aomap_fragment>', `{
            // 器具の本体のすぐ脇は本体の陰、少し離れたところが明るく、遠ざかると消える
            vec3 glow = vec3( 0.0 );
            for ( int i = 0; i < ${n}; i ++ ) {
              vec2 dp = vGlowPos.xz - uLampPos[ i ].xy;
              vec2 loc = vec2( dot( dp, uLampPos[ i ].zw ), dot( dp, vec2( -uLampPos[ i ].w, uLampPos[ i ].z ) ) );
              float d = length( max( abs( loc ) - vec2( ${hl}, ${hw} ), 0.0 ) );
              glow += uLampCol[ i ] * smoothstep( 0.0, 0.06, d ) * exp( -d / 0.2 );
            }
            reflectedLight.indirectDiffuse += glow * BRDF_Lambert( material.diffuseColor );
          }
          #include <aomap_fragment>`);
    };
  }

  /** 器具の見た目（位置・有無・発光色）を状態に合わせる */
  private syncInstances(force = false) {
    const mY = this.mGroup.position.y;
    let sig = `${this.emissiveOn ? 1 : 0}|${this.emergency.toFixed(3)}|${mY.toFixed(3)}`;
    for (const l of this.lamps) sig += `|${l.visible ? 1 : 0}${l.level.toFixed(3)}${l.yOffset.toFixed(3)}`;
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.lamps.forEach((l, i) => {
      const s = l.spot;
      const rot = (s.alongX ? 0 : Math.PI / 2) + (s.flip ? Math.PI : 0);
      _q.setFromAxisAngle(UP, rot);
      if (!l.visible) {
        this.bodies.setMatrixAt(i, _zero);
        this.covers.setMatrixAt(i, _zero);
      } else {
        _p.set(s.x, H - FIXTURE.h / 2 + l.yOffset, s.z);
        this.bodies.setMatrixAt(i, _m.compose(_p, _q, _s));
        _p.set(s.x, H - FIXTURE.h - FIXTURE.coverH / 2 + 0.008 + l.yOffset, s.z);
        this.covers.setMatrixAt(i, _m.compose(_p, _q, _s));
      }
      const v = VARIANTS[s.variant];
      _c.copy(v.color).multiplyScalar(v.gain * l.level * (this.emissiveOn ? 1 : 0));
      this.covers.setColorAt(i, _c);
      this.glowCol[i].set(v.color.r, v.color.g, v.color.b).multiplyScalar(LAMP_LUM * SIDE_GLOW * v.gain * l.level * (l.visible ? 1 : 0));
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.covers.instanceMatrix.needsUpdate = true;
    this.covers.instanceColor!.needsUpdate = true;
    this.bodies.computeBoundingSphere();
    this.covers.computeBoundingSphere();
    this.emUnits.forEach((u, i) => {
      const dy = u.inM ? mY : 0;
      this.emBody.setMatrixAt(i, _m.makeTranslation(u.x, H - 0.025 + dy, u.z));
      this.emLens.setMatrixAt(i, _m.makeTranslation(u.x + 0.04, H - 0.05 + dy, u.z));
      this.emLed.setMatrixAt(i, _m.makeTranslation(u.x - 0.07, H - 0.05 + dy, u.z + 0.03));
      _c.copy(EM_COLOR).multiplyScalar(this.emergency * 40);
      this.emLens.setColorAt(i, _c);
    });
    this.emBody.instanceMatrix.needsUpdate = true;
    this.emLens.instanceMatrix.needsUpdate = true;
    this.emLed.instanceMatrix.needsUpdate = true;
    this.emLens.instanceColor!.needsUpdate = true;
  }

  /** 照明の作り（面光源か点光源か、影の数）を切り替える。シェーダーの作り直しが起きる */
  setPreset(p: LightPreset) {
    const prev = this.preset;
    this.preset = { ...p };
    const n = this.lamps.length;
    while (this.rects.length > p.rects) {
      const l = this.rects.pop()!;
      this.group.remove(l);
      l.dispose();
    }
    while (this.rects.length < p.rects) {
      const l = new THREE.RectAreaLight(0xffffff, 0, FIXTURE.coverLen, FIXTURE.coverW);
      l.rotation.set(-Math.PI / 2, 0, 0);
      this.group.add(l);
      this.rects.push(l);
    }
    if (this.fills.length === 0) {
      for (let i = 0; i < n; i++) {
        const l = makeSpot();
        this.group.add(l, l.target);
        this.fills.push(l);
      }
    }
    while (this.slots.length > p.shadows) {
      const l = this.slots.pop()!;
      this.group.remove(l, l.target);
      l.dispose();
    }
    while (this.slots.length < p.shadows) {
      const l = makeSpot();
      l.castShadow = true;
      l.shadow.focus = 0.8;
      l.shadow.camera.near = 0.05;
      l.shadow.camera.far = 20;
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.025;
      l.shadow.radius = 3;
      this.group.add(l, l.target);
      this.slots.push(l);
    }
    for (const l of this.slots) {
      if (l.shadow.mapSize.x !== p.shadowSize || prev.shadowSize !== p.shadowSize) {
        l.shadow.mapSize.set(p.shadowSize, p.shadowSize);
        l.shadow.map?.dispose();
        l.shadow.map = null;
      }
    }
  }

  /** 環境マップを撮る間だけ、発光面を消す（反射に器具が二重に映らないように） */
  setEmissive(on: boolean) {
    this.emissiveOn = on;
    this.syncInstances(true);
  }

  /** 毎フレーム: 器具の状態を反映し、影付きスポットをカメラに近い器具（停電時は非常灯）へ配る */
  update(cam: THREE.Vector3) {
    this.syncInstances();
    const K = this.slots.length;
    const r0 = K >= 3 ? 3.0 : 1.5, r1 = K >= 3 ? 6.5 : 3.2;
    const em: Emitter[] = this.emitters;
    em.length = 0;
    const mY = this.mGroup.position.y;
    if (this.emergency > 0.001) {
      this.emUnits.forEach((u, i) => {
        const d = Math.hypot(cam.x - u.x, cam.z - u.z);
        const w = 1 - P.smooth(14, 18, d);
        if (w > 0) em.push({ x: u.x, z: u.z, y: H - 0.06 + (u.inM ? mY : 0), w, isLamp: false, idx: i });
      });
    }
    this.lamps.forEach((l, i) => {
      if (!l.visible || l.level < 0.001) return;
      const d = Math.hypot(cam.x - l.spot.x, cam.z - l.spot.z);
      const w = 1 - P.smooth(r0, r1, d);
      if (w > 0) em.push({ x: l.spot.x, z: l.spot.z, y: H - FIXTURE.h - FIXTURE.coverH + l.yOffset, w, isLamp: true, idx: i });
    });
    em.sort((a, b) => b.w - a.w);
    const share = new Float32Array(this.lamps.length);
    for (let k = 0; k < K; k++) {
      const s = this.slots[k];
      const e = em[k];
      if (!e) { s.intensity = 0; continue; }
      s.position.set(e.x, e.y - 0.005, e.z);
      s.target.position.set(e.x, 0, e.z);
      s.target.updateMatrixWorld();
      if (e.isLamp) {
        const l = this.lamps[e.idx];
        const v = VARIANTS[l.spot.variant];
        share[e.idx] = SHADOW_SHARE * e.w;
        s.color.copy(v.color);
        s.intensity = LAMP_LUM * COVER_AREA * v.gain * l.level * share[e.idx];
        s.angle = 1.53;
        s.penumbra = 1;
      } else {
        s.color.copy(EM_COLOR);
        s.intensity = EM_INTENSITY * this.emergency * e.w;
        s.angle = 1.2;
        s.penumbra = 0.9;
      }
    }
    // 面光源: カメラに近い器具から順に割り当てる。重み（距離で 1→0）の分だけ面光源、残りはスポットライトが受け持つ
    const R = this.rects.length;
    const rectW = new Float32Array(this.lamps.length);
    if (R) {
      const a0 = R >= 4 ? 3.5 : 1.5, a1 = R >= 4 ? 7.0 : 4.0;
      const cand = this.rectCand;
      cand.length = 0;
      this.lamps.forEach((l, i) => {
        if (!l.visible || l.level < 0.001) return;
        const w = 1 - P.smooth(a0, a1, Math.hypot(cam.x - l.spot.x, cam.z - l.spot.z));
        if (w > 0) cand.push({ i, w });
      });
      cand.sort((a, b) => b.w - a.w);
      this.rects.forEach((r, k) => {
        const c = cand[k];
        if (!c) { r.intensity = 0; return; }
        const l = this.lamps[c.i];
        const v = VARIANTS[l.spot.variant];
        rectW[c.i] = c.w;
        r.position.set(l.spot.x, H - FIXTURE.h - FIXTURE.coverH + l.yOffset, l.spot.z);
        r.width = l.spot.alongX ? FIXTURE.coverLen : FIXTURE.coverW;
        r.height = l.spot.alongX ? FIXTURE.coverW : FIXTURE.coverLen;
        r.color.copy(v.color);
        r.intensity = LAMP_LUM * v.gain * l.level * (1 - share[c.i]) * c.w;
      });
    }
    this.lamps.forEach((l, i) => {
      const v = VARIANTS[l.spot.variant];
      const on = l.visible ? l.level : 0;
      const y = H - FIXTURE.h - FIXTURE.coverH + l.yOffset;
      const f = this.fills[i];
      f.position.set(l.spot.x, y - 0.005, l.spot.z);
      f.target.position.set(l.spot.x, 0, l.spot.z);
      f.target.updateMatrixWorld();
      f.color.copy(v.color);
      f.intensity = LAMP_LUM * COVER_AREA * v.gain * on * (1 - share[i]) * (1 - rectW[i]);
    });
    // 影付きライトがない設定の停電: スポットライトのうち4つを非常灯に回す（停電中は器具が消えている）
    if (K === 0 && this.emergency > 0.001) {
      em.filter((e) => !e.isLamp).slice(0, 4).forEach((e, k) => {
        const f = this.fills[k];
        f.position.set(e.x, e.y, e.z);
        f.target.position.set(e.x, 0, e.z);
        f.target.updateMatrixWorld();
        f.color.copy(EM_COLOR);
        f.intensity = EM_INTENSITY * this.emergency * e.w;
      });
    }
  }
}
