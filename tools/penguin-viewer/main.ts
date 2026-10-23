import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadPenguins, PENGUIN_COUNT, type PenguinPose } from '../../src/penguins';

/*
 * ペンギンの走る動きを確かめる見本ページ（ゲームと同じ src/penguins.ts を使う）。
 * ビルド: npx vite build --config tools/penguin-viewer/vite.config.mjs
 */

/** ゲームと同じ値: 走る速さ（m/秒）、1 秒の歩数 */
const SPEED = 2.4, STEPS = 2.6;

const stage = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc4cbcf);
scene.fog = new THREE.Fog(0xc4cbcf, 8, 18);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

// 地下通路の床に近い、明るい灰色のタイル（目地あり）
const tc = document.createElement('canvas');
tc.width = tc.height = 256;
const g = tc.getContext('2d')!;
g.fillStyle = '#9a9c9a';
g.fillRect(0, 0, 256, 256);
for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
  const k = 196 + ((i + j) % 2) * 8;
  g.fillStyle = `rgb(${k},${k},${k - 2})`;
  g.fillRect(i * 128 + 3, j * 128 + 3, 122, 122);
}
const tile = new THREE.CanvasTexture(tc);
tile.colorSpace = THREE.SRGBColorSpace;
tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
tile.repeat.set(30, 30);
tile.anisotropy = 8;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ map: tile, roughness: 0.6 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 5, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7 });
sun.shadow.bias = -0.0005;
scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x666666, 0.6));

// 埋め込んだモデル（data: URL）は、置き場所によっては fetch で読めないので、ここで直接ほどく
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('data:')) return realFetch(input, init);
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes);
};
const pg = await loadPenguins();
pg.group.visible = true;
scene.add(pg.group);

let mode: 'one' | 'many' = 'one';
let speedK = 1, slow = 1;
const poses: PenguinPose[] = [];
const flock: (PenguinPose & { vmax: number })[] = [];
for (let i = 0; i < PENGUIN_COUNT; i++) {
  flock.push({
    x: ((i % 6) - 2.5) * 0.55 + (Math.random() - 0.5) * 0.2, z: -Math.floor(i / 6) * 0.75 - Math.random() * 0.3,
    yaw: (Math.random() - 0.5) * 0.15, scale: 0.85 + Math.random() * 0.2, phase: Math.random() * 6.28, run: 1, vmax: 0.92 + Math.random() * 0.16,
  });
}
// 1 羽はその場で走り、横から見えるように右を向ける
const one: PenguinPose = { x: 0, z: 0, yaw: Math.PI / 2, scale: 1, phase: 0, run: 1 };

function setMode(m: 'one' | 'many') {
  mode = m;
  document.getElementById('one')!.setAttribute('aria-pressed', String(m === 'one'));
  document.getElementById('many')!.setAttribute('aria-pressed', String(m === 'many'));
  if (m === 'many') { camera.position.set(1.2, 1.5, 6.5); controls.target.set(0, 0.6, 0); }
  else { camera.position.set(1.6, 1.0, 2.6); controls.target.set(0, 0.55, 0); }
}
setMode('one');
document.getElementById('one')!.onclick = () => setMode('one');
document.getElementById('many')!.onclick = () => setMode('many');
const speedEl = document.getElementById('speed') as HTMLInputElement, slowEl = document.getElementById('slow') as HTMLInputElement;
speedEl.oninput = () => { speedK = +speedEl.value; document.getElementById('speedOut')!.textContent = `${(SPEED * speedK).toFixed(1)} m/秒`; };
slowEl.oninput = () => { slow = +slowEl.value; document.getElementById('slowOut')!.textContent = `×${slow.toFixed(2)}`; };

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000) * slow;
  last = now;
  // ゲームでは速さに届くまでの間 run が 0→1 に上がる。ここでは速さのつまみで決める
  const run = Math.min(1, speedK);
  poses.length = 0;
  if (mode === 'one') {
    one.run = run;
    one.phase += dt * Math.PI * 2 * STEPS * (0.4 + 0.6 * run);
    poses.push(one);
  } else {
    // こちら（+z）へ走ってきて、手前を過ぎたら奥へ戻る
    for (const p of flock) {
      p.run = run;
      p.z += SPEED * speedK * p.vmax * dt;
      if (p.z > 3.5) p.z -= 8.5;
      p.phase += dt * Math.PI * 2 * STEPS * (0.4 + 0.6 * run) / p.scale;
      poses.push(p);
    }
  }
  pg.update(poses);
  controls.update();
  renderer.render(scene, camera);
});
