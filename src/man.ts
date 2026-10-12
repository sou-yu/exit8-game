import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as T from './textures';
import manGlb from './assets/man.glb?inline';

/*
 * 通行人（会社員の男性）。Blender で作った人物モデル（src/assets/man.glb）を読み込む。
 * モデルには歩行（Walk）・待機（Idle）の 1 秒ループと、笑顔の形状（モーフ Smile）が入っている。
 * 笑顔用の顔画像（head_smile）も同じファイルに入れてあり、異変ではモーフと顔画像をまとめて切り替える。
 * 骨組み・重み・歩行は tools/man/rig.mjs で作り直した。元の GLB からの手順は README に書いた。
 */

/**
 * 歩行アニメーションをそのままの速さで再生したときの歩く速さ（m/秒）。
 * 着いている足が 1 秒あたり約 1.02 m 後ろへ動く（ゲーム内で測った値）ので、この速さで進めば足が床で滑らない。
 */
export const WALK_SPEED = 1.02;

export interface Man {
  /** 足もとが原点で、+z が正面 */
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  walk: THREE.AnimationAction;
  idle: THREE.AnimationAction;
  /** 歩行アニメーションの再生速度を、移動の速さ（m/秒）に合わせる */
  setPace(speed: number): void;
  setSmile(on: boolean): void;
  /** 異変で初めて使う画像（先に GPU へ送っておく） */
  smileTex: THREE.Texture;
}

export async function loadMan(): Promise<Man> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const data = await (await fetch(manGlb)).arrayBuffer();
  const gltf = await loader.parseAsync(data, '');
  const model = gltf.scene;

  // 笑顔のモーフを持つメッシュ（顔・目・口の中・歯）と、顔の画像を使うマテリアル（顔・目）
  const smileMeshes: { mesh: THREE.Mesh; index: number }[] = [];
  const faceMats = new Set<THREE.MeshStandardMaterial>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = m.receiveShadow = true;
    const index = m.morphTargetDictionary?.Smile;
    if (index !== undefined) smileMeshes.push({ mesh: m, index });
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat.map?.name === 'anatomical_head_albedo_neck') faceMats.add(mat);
  });
  const normalTex = [...faceMats][0].map!;
  const parser = gltf.parser;
  const smileIndex = (parser.json.images as { name?: string }[]).findIndex((i) => i.name === 'head_smile');
  const smileImage = await parser.loadImageSource(smileIndex, parser.textureLoader);
  const smileTex = normalTex.clone();
  smileTex.source = smileImage.source;
  smileTex.needsUpdate = true;

  const mixer = new THREE.AnimationMixer(model);
  const clip = (name: string) => THREE.AnimationClip.findByName(gltf.animations, name)!;
  const walk = mixer.clipAction(clip('Walk')).play();
  const idle = mixer.clipAction(clip('Idle')).play();
  idle.setEffectiveWeight(0);

  const group = new THREE.Group();
  group.add(model);
  group.add(blob(0.9));
  return {
    group, mixer, walk, idle, smileTex,
    setPace(speed) { walk.timeScale = speed / WALK_SPEED; },
    setSmile(on) {
      smileMeshes.forEach(({ mesh, index }) => { mesh.morphTargetInfluences![index] = on ? 1 : 0; });
      faceMats.forEach((m) => { m.map = on ? smileTex : normalTex; m.needsUpdate = true; });
    },
  };
}

/** 足もとの柔らかい陰り（床に乗算で重ねる） */
let blobTex: THREE.Texture | null = null;
export function blob(size: number): THREE.Mesh {
  blobTex ??= T.blobTexture();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
    map: blobTex, blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true, depthWrite: false, toneMapped: false,
  }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.renderOrder = 1;
  return m;
}

/** 黒い人影（異変） */
export function buildShadow(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x030303 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.4, 6, 12), mat);
  body.scale.set(1, 1, 0.7);
  body.position.y = 0.92;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat);
  head.position.y = 1.86;
  g.add(head);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  g.add(blob(0.9));
  g.visible = false;
  return g;
}
