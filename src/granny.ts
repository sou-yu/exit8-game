import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as T from './textures';
import { blob } from './man';
import grannyGlb from './assets/granny.glb?inline';

/*
 * うどんをお盆で運ぶおばあさん（異変「振り向くと、すぐ後ろにおばあさんが立っている」）。
 * 8方向の画像から作ったモデル（src/assets/granny.glb、身長 1.55m、+z が正面、待機アニメーション Idle のみ）。
 * 頭の上に吹き出しを付ける。吹き出しはいつもカメラのほうを向く。
 */

export interface Granny {
  /** 足もとが原点で、+z が正面。普段は非表示 */
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  bubble: THREE.Sprite;
  /** 体の影を落とすか（後ろについて回っている間は、影が前に見えないよう切る） */
  setCastShadow(on: boolean): void;
}

export async function loadGranny(): Promise<Granny> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const data = await (await fetch(grannyGlb)).arrayBuffer();
  const gltf = await loader.parseAsync(data, '');
  const model = gltf.scene;
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.receiveShadow = true;
    m.frustumCulled = false; // 骨で動く体は境界が合わないことがあるので常に描く（非表示のときは group ごと止まる）
    meshes.push(m);
  });
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Idle')!).play();

  // 吹き出し。画面の明るさ（露出・トーンマップ）を通っても白く見え、光らない程度の明るさにする
  const bubble = new THREE.Sprite(new THREE.SpriteMaterial({
    map: T.bubbleTexture('お箸捨ててね'), color: new THREE.Color(0.62, 0.62, 0.62), transparent: true, depthWrite: false,
  }));
  bubble.center.set(0.2, 0); // 尾の先あたりを頭の上に合わせる
  bubble.scale.set(0.6, 0.25, 1);
  bubble.position.set(0.06, 1.58, 0.05);
  bubble.renderOrder = 5;
  bubble.visible = false;

  const group = new THREE.Group();
  group.add(model, bubble, blob(0.8));
  group.visible = false;
  return {
    group, mixer, bubble,
    setCastShadow(on) { meshes.forEach((m) => { m.castShadow = on; }); },
  };
}
