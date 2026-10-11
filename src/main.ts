import * as THREE from 'three';
import { buildWorld, canStand, FORWARD_SHIFT, LM, LS, S_CENTER, W, type World } from './world';
import { Renderer, QUALITY_LABEL, type Quality } from './render';
import { ANOMALIES, ANOMALY_BY_ID, resetWorld, setHangingSign, type ManState } from './anomalies';
import { numberSignTexture } from './textures';
import { Sound } from './audio';
import { TouchControls, isTouchDevice } from './touch';
import { loadMan, WALK_SPEED } from './man';

const GOAL = 8;
const ANOMALY_RATE = 0.6;
const EYE = 1.6;
const RADIUS = 0.3;
/** 縦の視野角（度）。人の目で見た印象に近い、広角すぎない値 */
const FOV = 56;

// ---- 起動中の表示とエラー表示（重い準備の前に画面を出し、止まった場所が分かるようにする） ----
const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;
function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}
function showError(msg: string) {
  document.getElementById('overlay')!.classList.remove('hidden');
  startBtn.disabled = true;
  setStatus(`起動できませんでした: ${msg}`, true);
}
addEventListener('error', (e) => showError(e.message || String(e.error)));
addEventListener('unhandledrejection', (e) => showError(String((e as PromiseRejectionEvent).reason)));
/** 画面の書き換えを1回待つ（タブが裏にあっても止まらないよう、時間でも抜ける） */
const nextPaint = () => new Promise<void>((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 120); });
const SAFE_KEY = 'loop-passage-safe';
const safeMode = (() => { try { return localStorage.getItem(SAFE_KEY) === '1'; } catch { return false; } })();

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
let FORCE = params.get('anomaly');

// ---- 描画 ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.05, 90);
camera.rotation.order = 'YXZ';
const renderer = new Renderer(scene, camera); // 異方性フィルタの上限を先に取るため、ワールドより先に作る
document.getElementById('app')!.appendChild(renderer.dom);
// GPU が描画を続けられなくなったとき（ドライバのリセットなど）。次回は軽量設定で起動する
renderer.dom.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  try { localStorage.setItem(SAFE_KEY, '1'); } catch { /* 保存できなくても表示は出す */ }
  game.gameState = 'paused';
  document.exitPointerLock?.();
  showError('GPU の描画が止まりました。ページを再読み込みすると軽量設定で起動します');
});

let world!: World;
let qualityMsgUntil = 0;
renderer.onQualityChange = () => { qualityMsgUntil = performance.now() + 2500; };
const sound = new Sound();
const signTex = Array.from({ length: GOAL + 2 }, (_, i) => numberSignTexture(i));

// ---- 状態 ----
type GameState = 'title' | 'playing' | 'paused' | 'clear';
const game = {
  gameState: 'title' as GameState,
  currentLevel: 0,
  hasAnomaly: false,
  anomalyId: null as string | null,
  playerDecision: null as 'forward' | 'back' | null,
  enteredM: false,
  tInM: -1,
  recent: [] as string[],
  found: new Set<string>(),
  startTime: 0,
  mem: {} as Record<string, number>,
};
const player = { x: 1.5, z: 1.5, yaw: -Math.PI / 2, pitch: 0, bob: 0, stepAcc: 0 };
/** 前後・左右の速さ（m/s、体の向き基準）。急に止まったり動き出したりしないよう、なめらかに追従させる */
const vel = { f: 0, s: 0, amp: 0 };
const man: ManState = { z: -LM + 1, walking: false, visible: false, speed: WALK_SPEED, stare: false };

const signShown = new Map<THREE.Mesh, number>();
function setSign(mesh: THREE.Mesh, n: number) {
  const m = mesh.material as THREE.MeshLambertMaterial;
  m.map = signTex[Math.min(n, signTex.length - 1)];
  m.needsUpdate = true;
  signShown.set(mesh, n);
}

/*
 * ループ直後に視界に入っている看板は、直前に見えていた番号のまま残し、
 * 視界から外れた瞬間に新しい番号へ差し替える（切り替わりを見せないため）。
 */
let pendingSign: { mesh: THREE.Mesh; n: number } | null = null;
const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const signBox = new THREE.Box3();
function updatePendingSign() {
  if (!pendingSign) return;
  camera.updateMatrixWorld();
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);
  signBox.setFromObject(pendingSign.mesh);
  if (!frustum.intersectsBox(signBox)) {
    setSign(pendingSign.mesh, pendingSign.n);
    pendingSign = null;
  }
}

function pickAnomaly(): string | null {
  if (game.currentLevel === 0 || game.currentLevel >= GOAL) return null;
  if (FORCE && ANOMALY_BY_ID.has(FORCE)) return FORCE;
  if (Math.random() >= ANOMALY_RATE) return null;
  // 直近2回の異変は除外し、未発見の異変を優先する
  let pool = ANOMALIES.filter((a) => !game.recent.includes(a.id));
  const unseen = pool.filter((a) => !game.found.has(a.id));
  if (unseen.length && Math.random() < 0.7) pool = unseen;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function generateCorridor() {
  resetWorld(world, man);
  game.anomalyId = pickAnomaly();
  game.hasAnomaly = game.anomalyId !== null;
  game.enteredM = false;
  game.tInM = -1;
  game.playerDecision = null;
  game.mem = {};
  if (game.anomalyId) {
    ANOMALY_BY_ID.get(game.anomalyId)!.apply(world, man);
    game.recent = [game.anomalyId, ...game.recent].slice(0, 2);
  }
  if (game.currentLevel >= GOAL) setHangingSign(world, 'goal');
  const s = world.signs;
  [s.aEast, s.aWest, s.bEast, s.bWest].forEach((m) => setSign(m, game.currentLevel));
  man.z = -LM + 1;
  man.walking = false;
  man.visible = false;
  world.man.group.visible = false;
  world.man.walk.time = 0;
  manWalkW = 1;
  sound.setAmbient(0.35);
}

/** 判定通路に入った時点で、両端の待合の看板を「判定後の番号」にしておく（通路内からは見えない位置） */
function onEnterM() {
  game.enteredM = true;
  pendingSign = null;
  game.tInM = 0;
  const next = game.currentLevel + 1;
  setSign(world.signs.aWest, game.hasAnomaly ? next : 0);
  setSign(world.signs.bEast, game.hasAnomaly ? 0 : Math.min(next, GOAL));
}

function judge(turnedBack: boolean) {
  game.playerDecision = turnedBack ? 'back' : 'forward';
  if (game.currentLevel >= GOAL) {
    if (!turnedBack) return gameClear();
    game.currentLevel = 0;
  } else {
    const correct = game.hasAnomaly === turnedBack;
    if (correct && game.anomalyId) game.found.add(game.anomalyId);
    game.currentLevel = correct ? game.currentLevel + 1 : 0;
  }
  generateCorridor();
}

function gameClear() {
  game.gameState = 'clear';
  document.exitPointerLock?.();
  const sec = Math.floor((performance.now() - game.startTime) / 1000);
  document.getElementById('clear-time')!.textContent =
    `クリアタイム ${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
  document.getElementById('clear-found')!.textContent =
    `見つけた異変: ${game.found.size} / ${ANOMALIES.length} 種類`;
  document.getElementById('clear')!.classList.remove('hidden');
}

function resetGame() {
  pendingSign = null;
  game.currentLevel = 0;
  game.found.clear();
  game.recent = [];
  player.x = 1.5; player.z = 1.5; player.yaw = -Math.PI / 2; player.pitch = 0;
  vel.f = vel.s = 0;
  generateCorridor();
}

// ---- 入力 ----
const keys = new Set<string>();
const statsEl = document.getElementById('stats')!;
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyQ') renderer.cycleQuality();
  if (e.code === 'KeyF') {
    renderer.measureGpu = statsEl.classList.toggle('on');
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const canvas = renderer.dom;
addEventListener('mousemove', (e) => {
  if (game.gameState !== 'playing') return;
  // マウスロックが使えない環境では、ドラッグで視点を回す
  if (document.pointerLockElement !== canvas && !(e.buttons & 1)) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0022, -1.3, 1.3);
});
const overlay = document.getElementById('overlay')!;
// タッチ操作（iPhone / iPad）。マウスロックは使わず、左で移動・右で視点
const touchMode = isTouchDevice();
const touch = new TouchControls(canvas, (dx, dy) => {
  player.yaw -= dx;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy, -1.3, 1.3);
});
const START_LABEL = touchMode ? 'タップして始める' : 'クリックして始める';
if (touchMode) document.body.classList.add('touch');
function pause() {
  if (game.gameState !== 'playing') return;
  game.gameState = 'paused';
  touch.enabled = false;
  touch.reset();
  overlay.classList.remove('hidden');
  startBtn.textContent = touchMode ? 'タップして再開' : 'クリックして再開';
}
document.getElementById('pause')!.addEventListener('click', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden && touchMode) pause(); });
function begin() {
  sound.start();
  if (game.gameState === 'title') game.startTime = performance.now();
  game.gameState = 'playing';
  overlay.classList.add('hidden');
  if (touchMode) { touch.enabled = true; return; }
  try {
    (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
  } catch { /* ロック不可ならドラッグ操作 */ }
}
document.getElementById('start')!.addEventListener('click', begin);
canvas.addEventListener('click', () => { if (game.gameState === 'playing' && !touchMode) canvas.requestPointerLock?.(); });
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && game.gameState === 'playing') pause();
});
document.getElementById('restart')!.addEventListener('click', () => {
  document.getElementById('clear')!.classList.add('hidden');
  resetGame();
  game.gameState = 'title';
  begin();
});

// ---- 更新 ----
function updatePlayer(dt: number) {
  let f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  let s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (!f && !s && (touch.f || touch.s)) { f = touch.f; s = touch.s; } // スティックは倒した量で速さが変わる
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.run ? 3.0 : 1.8;
  let tf = 0, ts = 0;
  if (f || s) {
    const len = Math.max(1, Math.hypot(f, s));
    tf = (f / len) * speed;
    ts = (s / len) * speed;
  }
  const k = 1 - Math.exp(-dt / (f || s ? 0.12 : 0.09));
  vel.f += (tf - vel.f) * k;
  vel.s += (ts - vel.s) * k;
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  const mx = (-sin * vel.f + cos * vel.s) * dt;
  const mz = (-cos * vel.f - sin * vel.s) * dt;
  if (canStand(player.x + mx, player.z, RADIUS)) player.x += mx;
  if (canStand(player.x, player.z + mz, RADIUS)) player.z += mz;
  const moved = Math.hypot(mx, mz);
  player.bob += (moved * Math.PI * 2) / 1.5; // 1.5m で左右1歩ずつ
  player.stepAcc += moved;
  if (player.stepAcc > 0.75) { player.stepAcc = 0; sound.step(); }

  // 判定通路への出入り
  if (!game.enteredM && player.z < -4) onEnterM();
  if (game.enteredM && player.z > -1) {
    const carry = signShown.get(world.signs.aEast)!;
    judge(true);
    carrySign(carry);
    // 待合 S_A の中心で180度回転させ、引き返した先を新しい待合にする
    player.x = 2 * S_CENTER.x - player.x;
    player.z = 2 * S_CENTER.y - player.z;
    player.yaw += Math.PI;
  } else if (player.z < -LM + 1) {
    const carry = signShown.get(world.signs.bWest)!;
    judge(false);
    carrySign(carry);
    player.x += FORWARD_SHIFT.x;
    player.z += FORWARD_SHIFT.y;
  }
}

function carrySign(shown: number) {
  if (game.gameState !== 'playing') return;
  pendingSign = { mesh: world.signs.aWest, n: game.currentLevel };
  setSign(world.signs.aWest, shown);
}

/** 通行人の歩行アニメーションの重み（1 で歩行、0 で待機） */
let manWalkW = 1;
function updateMan(dt: number) {
  const g = world.man.group;
  if (!man.walking && !man.visible && player.x > 5.5 && player.z < W) {
    man.walking = true;
    man.visible = true;
  }
  if (!man.visible) { g.visible = false; return; }
  g.visible = true;
  const mx = LS - W / 2 + 0.6;
  const d = Math.hypot(player.x - mx, player.z - man.z);
  if (man.stare && d < 4.5 && player.z < man.z + 1.5) man.walking = false;
  if (man.walking) {
    man.z += man.speed * dt;
    g.rotation.y = 0;
  } else {
    // 立ち止まり、こちらへゆっくり向き直る
    const target = Math.atan2(player.x - mx, player.z - man.z);
    let diff = target - g.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    g.rotation.y += diff * (1 - Math.exp(-dt / 0.3));
  }
  // 歩行と待機のアニメーションをなめらかに切り替える（歩幅は移動の速さに合わせる）
  manWalkW += ((man.walking ? 1 : 0) - manWalkW) * (1 - Math.exp(-dt / 0.15));
  world.man.walk.setEffectiveWeight(manWalkW);
  world.man.idle.setEffectiveWeight(1 - manWalkW);
  world.man.setPace(man.speed);
  world.man.mixer.update(dt);
  g.position.set(mx, 0, man.z);
  if (man.z > -1.2) { man.visible = false; g.visible = false; }
}

const hint = document.getElementById('hint')!;
const debugEl = document.getElementById('debug')!;
let last = performance.now();
let time = 0;
let frames = 0;
let statsAt = 0;
const camRight = new THREE.Vector3();
function frame() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  time += dt;
  if (game.gameState === 'playing') {
    updatePlayer(dt);
    if (game.enteredM) game.tInM += dt;
    updateMan(dt);
    const a = game.anomalyId ? ANOMALY_BY_ID.get(game.anomalyId) : null;
    a?.update?.({
      world, dt, px: player.x, pz: player.z, tInM: game.tInM, man,
      sound: (n, vol) => (n === 'thud' ? sound.thud() : n === 'drip' ? sound.drip(vol) : sound.flicker()),
    }, game.mem);
    hint.textContent = game.currentLevel === 0 && !game.enteredM && time < 30
      ? '番号の看板を確かめて、先の通路へ。いつもと違えば引き返す。' : '';
  }
  // 歩くときの頭の揺れ: 上下は1歩ごと、左右は2歩で1往復。止まると消える
  const spd = Math.hypot(vel.f, vel.s);
  vel.amp += (Math.min(1, spd / 1.8) - vel.amp) * (1 - Math.exp(-dt / 0.25));
  const bobY = -Math.cos(player.bob * 2) * 0.011 * vel.amp;
  const bobX = Math.sin(player.bob) * 0.006 * vel.amp;
  camRight.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  camera.position.set(player.x + camRight.x * bobX, EYE + bobY, player.z + camRight.z * bobX);
  camera.rotation.set(player.pitch, player.yaw, 0);
  world.lighting.update(camera.position);
  updatePendingSign();
  if (DEBUG) {
    debugEl.textContent = `level ${game.currentLevel} | anomaly ${game.anomalyId ?? '-'} | ` +
      `pos ${player.x.toFixed(1)},${player.z.toFixed(1)} | ${game.gameState}`;
  }
  if (performance.now() < qualityMsgUntil) hint.textContent = touchMode ? QUALITY_LABEL[renderer.level] : `${QUALITY_LABEL[renderer.level]}（Qキーで切替）`;
  renderer.render(dt, world.envLevel, game.gameState === 'playing', time);
  frames++;
  (window as unknown as { __frames: number }).__frames = frames;
  if (statsEl.classList.contains('on') && now > statsAt) {
    statsAt = now + 250;
    const st = renderer.stats;
    statsEl.textContent = `${QUALITY_LABEL[renderer.level]}\n` +
      `${st.fps.toFixed(0)} fps (${st.ms.toFixed(1)} ms)\n` +
      `GPU ${st.gpuMs >= 0 ? st.gpuMs.toFixed(1) + ' ms' : '計測不可'}\n` +
      `描画呼び出し ${st.calls} / 三角形 ${(st.tris / 1000).toFixed(0)}k\n` +
      `解像度 ${st.px}`;
  }
  requestAnimationFrame(frame);
}

async function init() {
  startBtn.disabled = true;
  startBtn.textContent = '準備中…';
  setStatus('通行人を読み込んでいます');
  await nextPaint();
  const manModel = await loadMan();
  setStatus('通路を組み立てています');
  await nextPaint();
  world = buildWorld(manModel);
  scene.add(world.group);
  renderer.attach(world.lighting);
  if (params.has('q')) {
    renderer.autoQuality = false;
    renderer.setQuality(Math.min(2, Math.max(0, Number(params.get('q')) || 0)) as Quality);
  } else if (safeMode) {
    renderer.setQuality(2);
  } else if (touchMode) {
    // スマートフォンは軽量、タブレットは標準から始める
    renderer.setQuality(Math.min(screen.width, screen.height) < 600 ? 2 : 1);
  } else if (renderer.integratedGpu) {
    renderer.setQuality(1); // 内蔵 GPU は標準から始める（Q キーで高品質にもできる）
  }
  generateCorridor();
  setStatus('照明を準備しています');
  const slow = setTimeout(() => setStatus('照明を準備しています（時間がかかっています。そのままお待ちください）'), 15000);
  await nextPaint();
  // 通行人は最初は隠れているので、シェーダーを作る間だけ見せておく（初めて現れたときに止まらないように）
  world.man.group.visible = true;
  world.leak.group.visible = true; // 異変の小道具も同じ
  world.hangingScrawl.visible = true;
  renderer.gl.initTexture(world.man.smileTex);
  await renderer.precompile();
  renderer.captureEnvironment(new THREE.Vector3(LS - W / 2, 1.5, -15), [world.man.group, world.shadow, world.leak.group, world.hangingScrawl]);
  await renderer.precompile();
  warmUpMan();
  world.leak.group.visible = false;
  world.hangingScrawl.visible = false;
  clearTimeout(slow);
  setStatus('');
  startBtn.disabled = false;
  startBtn.textContent = START_LABEL;
  try { localStorage.removeItem(SAFE_KEY); } catch { /* なくてもよい */ }
  frame();
  exposeForTests();
}

/** 影と AO で使うシェーダーは実際に描くまで作られないので、通行人を目の前に置いて 1 枚描いておく */
function warmUpMan() {
  const g = world.man.group;
  g.visible = true;
  g.position.set(player.x + 2.5, 0, player.z); // 開始時は +x の向きを見ている
  camera.position.set(player.x, EYE, player.z);
  camera.rotation.set(0, player.yaw, 0);
  world.lighting.update(camera.position);
  renderer.render(0, world.envLevel, false, 0);
  g.visible = false;
}

function exposeForTests() {
(window as unknown as { __game: unknown }).__game = {
  game, player, man, renderer, world,
  force: (id: string | null) => { FORCE = id; },
  start: () => { sound.start(); game.startTime = performance.now(); game.gameState = 'playing'; overlay.classList.add('hidden'); },
  setLevel: (n: number) => { game.currentLevel = n; generateCorridor(); },
  keys,
};
}

init().catch((e) => showError(e instanceof Error ? e.message : String(e)));
