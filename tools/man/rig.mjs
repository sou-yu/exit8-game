// 通行人の骨組みを作り直し、歩行（Walk）と待機（Idle）を作り直す
// usage: node rig.mjs <office_man_rigged.glb> <出力.glb> <three.module.js の絶対パス>
//  - 骨の位置を体の形に合わせて置き直す（股関節・膝・足首・つま先の付け根）。骨の向きはすべてモデルの軸にそろえる
//  - 体（シャツ・ズボン・靴）の重みを、骨からの距離でなめらかに付け直す。顔・首・手・鞄・スマホは元の重みのまま
//  - 歩行は脚の IK で作る（着いている足が床で滑らない・かかとから着いてつま先で蹴る・腰の上下と左右の揺れ・腕の振り）
// 座標は glTF のまま（Y 上・+Z 前・+X がモデルの左）
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [, , input, out, threePath] = process.argv;
const THREE = await import(threePath);
const { Vector3, Quaternion, Matrix4 } = THREE;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();
const skin = root.listSkins()[0];
const joints = skin.listJoints();
const J = Object.fromEntries(joints.map((j, i) => [j.getName(), { node: j, i }]));

// ---- 元の骨の世界での姿勢（指・スマホ・鞄はこのまま使う） ----
const origWorld = new Map();
for (const j of joints) origWorld.set(j.getName(), new Matrix4().fromArray(j.getWorldMatrix()));

// ---- 新しい骨の位置（世界座標） ----
const P = {
  Root: [0, 0, 0], Hips: [0, 0.89, -0.005], Spine: [0, 0.99, -0.005], Chest: [0, 1.17, -0.005],
  Neck: [0, 1.40, 0], Head: [0, 1.51, 0],
};
for (const [s, sx] of [['L', 1], ['R', -1]]) {
  P[`Thigh.${s}`] = [sx * 0.095, 0.88, -0.005];
  P[`Shin.${s}`] = [sx * 0.13, 0.49, 0.018];
  P[`Foot.${s}`] = [sx * 0.145, 0.085, -0.014];
  P[`Toe.${s}`] = [sx * 0.145, 0.03, 0.125];
  P[`Shoulder.${s}`] = [sx * 0.04, 1.38, 0];
  P[`UpperArm.${s}`] = [sx * 0.211, 1.365, 0];
  P[`Forearm.${s}`] = [sx * 0.29, 1.12, 0.013];
  P[`Hand.${s}`] = [sx * 0.332, 0.86, 0.037];
}
const TOE_TIP = 0.20; // つま先の先端（z）

// 骨の世界での姿勢: 位置だけ（回転なし）。指・スマホ・鞄は元の姿勢
const RIGID = new Set(['Finger0.L', 'Finger1.L', 'Finger2.L', 'Finger3.L', 'Phone', 'Bag', 'Finger0.R', 'Finger1.R', 'Finger2.R', 'Finger3.R']);
const newWorld = new Map();
for (const j of joints) {
  const n = j.getName();
  newWorld.set(n, RIGID.has(n) ? origWorld.get(n).clone() : new Matrix4().makeTranslation(...P[n]));
}
const parentOf = new Map();
for (const j of joints) for (const c of j.listChildren()) parentOf.set(c.getName(), j.getName());
const restLocal = new Map();
for (const j of joints) {
  const n = j.getName(), pn = parentOf.get(n);
  const local = pn ? new Matrix4().copy(newWorld.get(pn)).invert().multiply(newWorld.get(n)) : newWorld.get(n).clone();
  const t = new Vector3(), q = new Quaternion(), s = new Vector3();
  local.decompose(t, q, s);
  j.setTranslation(t.toArray()).setRotation(q.toArray()).setScale([1, 1, 1]);
  restLocal.set(n, { t, q });
}
// 逆バインド行列
const ibm = skin.getInverseBindMatrices();
const ibmArr = new Float32Array(joints.length * 16);
joints.forEach((j, i) => ibmArr.set(new Matrix4().copy(newWorld.get(j.getName())).invert().toArray(), i * 16));
ibm.setArray(ibmArr);

// ---- 重み ----
// 骨ごとの線分と太さ（距離を太さで割ってから比べる）
const SEG = {
  Hips: [P.Hips, P.Spine, 0.14], Spine: [P.Spine, P.Chest, 0.14], Chest: [P.Chest, [0, 1.37, -0.005], 0.14],
  Neck: [P.Neck, P.Head, 0.06],
};
for (const s of 'LR') {
  SEG[`Thigh.${s}`] = [P[`Thigh.${s}`], P[`Shin.${s}`], 0.085];
  SEG[`Shin.${s}`] = [P[`Shin.${s}`], P[`Foot.${s}`], 0.06];
  SEG[`Foot.${s}`] = [P[`Foot.${s}`], P[`Toe.${s}`], 0.05];
  SEG[`Toe.${s}`] = [P[`Toe.${s}`], [P[`Toe.${s}`][0], 0.02, TOE_TIP], 0.035];
  SEG[`Shoulder.${s}`] = [P[`Shoulder.${s}`], P[`UpperArm.${s}`], 0.07];
  SEG[`UpperArm.${s}`] = [P[`UpperArm.${s}`], P[`Forearm.${s}`], 0.055];
  SEG[`Forearm.${s}`] = [P[`Forearm.${s}`], P[`Hand.${s}`], 0.045];
}
const segDist = (p, [a, b]) => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2));
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
};
// 元の重みでいちばん大きい骨から、その頂点がどの部分か決める
const part = (name) => {
  if (/^(Hand|Finger|Phone|Bag)/.test(name)) return 'keep';
  if (/^(Shoulder|UpperArm|Forearm)\.L/.test(name)) return 'armL';
  if (/^(Shoulder|UpperArm|Forearm)\.R/.test(name)) return 'armR';
  if (/^(Thigh|Shin|Foot|Toe)\.L/.test(name)) return 'legL';
  if (/^(Thigh|Shin|Foot|Toe)\.R/.test(name)) return 'legR';
  return 'torso';
};
const TORSO = ['Hips', 'Spine', 'Chest', 'Neck'];
const ALLOW = {
  torso: [...TORSO, 'Thigh.L', 'Thigh.R', 'Shoulder.L', 'Shoulder.R', 'UpperArm.L', 'UpperArm.R'],
  armL: ['Spine', 'Chest', 'Neck', 'Shoulder.L', 'UpperArm.L', 'Forearm.L'],
  armR: ['Spine', 'Chest', 'Neck', 'Shoulder.R', 'UpperArm.R', 'Forearm.R'],
  legL: ['Hips', 'Spine', 'Thigh.L', 'Shin.L', 'Foot.L', 'Toe.L'],
  legR: ['Hips', 'Spine', 'Thigh.R', 'Shin.R', 'Foot.R', 'Toe.R'],
};
const POW = 6;
const KEEP_ABOVE = 1.40; // 襟と首は元の重み（顔のメッシュとのつなぎ目を変えない）
function weightsFor(p, tag) {
  const ws = [];
  for (const b of ALLOW[tag]) {
    const [a, c, r] = SEG[b];
    let w = (r / Math.max(segDist(p, [a, c]), 0.004)) ** POW;
    const y = p[1];
    // 腰より上は太ももを効かせない／太ももの付け根より下は腰を効かせない
    if (b.startsWith('Thigh')) w *= y > 0.86 ? Math.exp(-(((y - 0.86) / 0.05) ** 2)) : 1;
    if (b === 'Hips') w *= y < 0.86 ? Math.exp(-(((y - 0.86) / 0.06) ** 2)) : 1;
    if (b === 'Spine' && tag.startsWith('leg')) w *= 0.5;
    if (b === 'Neck') w *= y < 1.36 ? Math.exp(-(((y - 1.36) / 0.03) ** 2)) : 1;
    ws.push([w, b]);
  }
  ws.sort((u, v) => v[0] - u[0]);
  const top = ws.slice(0, 4);
  const sum = top.reduce((s, [w]) => s + w, 0);
  return top.map(([w, b]) => [w / sum, J[b].i]);
}

const stats = { kept: 0, re: 0 };
for (const mesh of root.listMeshes()) {
  if (mesh.getName() !== 'Shirt_body') continue;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), jo = prim.getAttribute('JOINTS_0'), we = prim.getAttribute('WEIGHTS_0');
    const n = pos.getCount();
    const J4 = new Uint16Array(n * 4), W4 = new Float32Array(n * 4);
    const p = [0, 0, 0], jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, p); jo.getElement(i, jj); we.getElement(i, ww);
      let best = 0;
      for (let k = 1; k < 4; k++) if (ww[k] > ww[best]) best = k;
      const tag = part(joints[jj[best]].getName());
      if (tag === 'keep' || p[1] >= KEEP_ABOVE) {
        for (let k = 0; k < 4; k++) { J4[i * 4 + k] = jj[k]; W4[i * 4 + k] = ww[k]; }
        stats.kept++;
        continue;
      }
      weightsFor(p, tag).forEach(([w, ji], k) => { J4[i * 4 + k] = ji; W4[i * 4 + k] = w; });
      stats.re++;
    }
    jo.setArray(J4); we.setArray(W4);
  }
}
console.log('weights', stats);

// ---- 手の左右 ----
// 元の手は左右が逆の形（親指が体の内側）だったので、手首の中心を通る面で手を鏡に映す。
// 手に持ったスマホと鞄も同じ面で映して、握り方を合わせる。手首の境目は袖口の中に隠れる
const WRIST_X = 0.3318;
let mirrored = 0;
for (const mesh of root.listMeshes()) {
  const name = mesh.getName();
  const whole = name === 'Cube' || name === 'Cube.017'; // 鞄・スマホ
  if (!whole && name !== 'Shirt_body') continue;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), nrm = prim.getAttribute('NORMAL'), jo = prim.getAttribute('JOINTS_0'), we = prim.getAttribute('WEIGHTS_0');
    const n = pos.getCount(), flip = new Uint8Array(n);
    const p = [0, 0, 0], q = [0, 0, 0], jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!whole) {
        jo.getElement(i, jj); we.getElement(i, ww);
        let best = 0;
        for (let k = 1; k < 4; k++) if (ww[k] > ww[best]) best = k;
        if (!/^(Hand|Finger)/.test(joints[jj[best]].getName())) continue;
      }
      pos.getElement(i, p);
      const c = Math.sign(p[0]) * WRIST_X;
      pos.setElement(i, [2 * c - p[0], p[1], p[2]]);
      nrm.getElement(i, q); nrm.setElement(i, [-q[0], q[1], q[2]]);
      flip[i] = 1; mirrored++;
    }
    // 映した三角形は裏返るので、頂点の順を入れ替える
    const idx = prim.getIndices(), a = idx.getArray();
    for (let t = 0; t < a.length; t += 3) {
      if (flip[a[t]] + flip[a[t + 1]] + flip[a[t + 2]] >= 2) { const x = a[t + 1]; a[t + 1] = a[t + 2]; a[t + 2] = x; }
    }
    idx.setArray(a);
  }
}
console.log('mirrored vertices', mirrored);

// ---- アニメーション ----
// 骨はすべてモデルの軸にそろえたので、回転はモデルの軸（x: 左、y: 上、z: 前）で書ける
const AXIS = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
const deg = Math.PI / 180;
let pose;
function reset() { pose = new Map(); }
function rot(name, ...turns) {
  const q = new Quaternion();
  for (const [ax, d] of turns) q.premultiply(new Quaternion().setFromAxisAngle(AXIS[ax], d * deg));
  pose.set(name, { ...(pose.get(name) || {}), q });
}
function move(name, v) { pose.set(name, { ...(pose.get(name) || {}), t: v }); }

const v3 = (a) => new Vector3(...a);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const L1 = v3(sub(P['Shin.L'], P['Thigh.L'])).length();
const L2 = v3(sub(P['Foot.L'], P['Shin.L'])).length();
const ang = (v) => Math.atan2(v[2], -v[1]); // 矢状面で真下からの前向きの角度
const A1 = ang(sub(P['Shin.L'], P['Thigh.L'])), A2 = ang(sub(P['Foot.L'], P['Shin.L']));
const HIP_H = P['Thigh.L'][1] - P['Foot.L'][1];
const LMAX = (L1 + L2) * 0.985;   // 着いている脚の伸ばしきらない長さ
const HEEL = P['Foot.L'][2] - (-0.084);       // 足首からかかとまで（前後）
const BALL = P['Toe.L'][2] - P['Foot.L'][2];   // 足首から指の付け根まで
const FPS = 30;
const T = 1.2;        // 2 歩で 1.2 秒
const STANCE = 0.6;   // 周期のうち足が床に着いている割合
const S = 0.47;       // 1 歩の歩幅（着いている足が後ろへ動く距離）
const LIFT = 0.07;
const WALK_SPEED = S / (STANCE * T);
console.log({ L1, L2, A1: A1 / deg, A2: A2 / deg, HIP_H, LMAX, HEEL, BALL, WALK_SPEED });

const smooth = (u) => u * u * (3 - 2 * u);
function ankleTarget(ph) {
  ph = ((ph % 1) + 1) % 1;
  if (ph < STANCE) return [S / 2 - (S * ph) / STANCE, 0];
  const u = (ph - STANCE) / (1 - STANCE);
  // 前へは最初ゆっくり、真ん中で速く、着く前にゆるめる
  return [-S / 2 + S * (0.5 - 0.5 * Math.cos(Math.PI * u)), LIFT * Math.sin(Math.PI * u) ** 0.8 * (1 - 0.35 * u)];
}
/** 足の角度（度、つま先を下げるのが +）。かかとから着き、指の付け根を軸にかかとを上げて蹴る */
function footAngle(ph) {
  ph = ((ph % 1) + 1) % 1;
  if (ph < 0.1) return -10 * (1 - smooth(ph / 0.1));
  if (ph < 0.38) return 0;
  if (ph < STANCE) return 22 * smooth((ph - 0.38) / (STANCE - 0.38));
  const u = (ph - STANCE) / (1 - STANCE);
  return 22 * (1 - smooth(Math.min(1, u / 0.45))) - 14 * Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.3) / 0.7)));
}
/** 足の角度に合わせて足首が上がる量（かかと・指の付け根を軸に回る） */
function ankleLift(ph) {
  ph = ((ph % 1) + 1) % 1;
  if (ph >= STANCE) return 0;
  const a = footAngle(ph) * deg;
  return a > 0 ? BALL * Math.sin(a) : HEEL * Math.sin(-a);
}
function solveLeg(f, d) {
  const D = Math.min(Math.hypot(f, d), L1 + L2 - 1e-4);
  const k = Math.PI - Math.acos((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2));
  const th = Math.atan2(f, d) + Math.acos((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D));
  return [th, k];
}
function pelvisDrop(phL) {
  let acc = 0, n = 0;
  for (let k = -3; k <= 3; k++) {
    const p = phL + k * 0.02;
    let dz = 0;
    for (const ph of [p, p + 0.5]) {
      const [f, lift] = ankleTarget(ph);
      if (lift === 0) dz = Math.min(dz, Math.sqrt(LMAX * LMAX - f * f) - HIP_H + ankleLift(ph));
    }
    acc += dz; n++;
  }
  return acc / n;
}
function poseWalk(t) {
  reset();
  const phL = t / T, phR = phL + 0.5;
  const c = 2 * Math.PI * phL;
  const drop = pelvisDrop(phL);
  const sway = 0.018 * Math.sin(c - 0.35);            // 体重の乗った脚のほうへ
  move('Hips', [sway, drop, 0]);
  const th = {};
  for (const [s, ph] of [['L', phL], ['R', phR]]) {
    const [f, lift] = ankleTarget(ph);
    const [a, k] = solveLeg(f, HIP_H + drop - lift - ankleLift(ph));
    const g1 = a, g2 = a - k;             // 太もも・すねの、真下からの前向きの角度
    th[s] = a;
    rot(`Thigh.${s}`, ['x', -(g1 - A1) / deg]);
    rot(`Shin.${s}`, ['x', -((g2 - A2) - (g1 - A1)) / deg]);
    const fa = footAngle(ph);
    rot(`Foot.${s}`, ['x', fa + (g2 - A2) / deg]);
    // 蹴り出しでは指が床に残る
    rot(`Toe.${s}`, ['x', -Math.max(0, ph % 1 < STANCE ? fa : footAngle(ph) * (1 - Math.min(1, ((ph % 1) - STANCE) / 0.12)))]);
  }
  const d = (th.L - th.R) / deg;                       // 左脚が前なら +
  const yaw = 0.16 * d;                                // 前に出た脚の側の腰が前へ
  rot('Hips', ['y', -yaw], ['z', 2.2 * Math.sin(c - 0.35)], ['x', 1.5]);
  rot('Spine', ['y', yaw * 0.45], ['x', 1.5 + 0.8 * Math.cos(2 * c)]);
  rot('Chest', ['y', yaw * 0.6], ['z', -1.6 * Math.sin(c - 0.35)]);
  rot('Neck', ['y', -yaw * 0.25], ['x', -1.5]);
  rot('Head', ['y', -yaw * 0.25], ['x', -1.0 - 0.8 * Math.cos(2 * c)], ['z', 0.8 * Math.sin(c)]);
  // 腕は反対の脚と同じ向きに振る。手はひじから少し遅れてついてくる。鞄を持つ右腕は小さく
  const sL = -(th.R - th.L) / deg;                     // 右脚が前なら左腕が前（-x 回転）
  rot('Shoulder.L', ['x', sL * 0.04]);
  rot('UpperArm.L', ['x', sL * 0.45], ['z', 4]);
  rot('Forearm.L', ['x', -(10 + Math.max(0, -sL) * 0.35)]);
  rot('Hand.L', ['x', -3]);
  const sR = -(th.L - th.R) / deg;
  rot('Shoulder.R', ['x', sR * 0.03]);
  rot('UpperArm.R', ['x', sR * 0.22], ['z', -5]);
  rot('Forearm.R', ['x', -(5 + Math.max(0, -sR) * 0.12)]);
}
function poseIdle(t) {
  reset();
  const ph = (2 * Math.PI * t) / 4.0;
  move('Hips', [0.008 * Math.sin(ph), -0.004 + 0.002 * Math.sin(2 * ph), 0]);
  rot('Hips', ['z', 1.0 * Math.sin(ph)]);
  rot('Spine', ['x', 0.8 * Math.sin(2 * ph)], ['z', -0.7 * Math.sin(ph)]);
  rot('Chest', ['x', -0.8 * Math.sin(2 * ph)], ['z', -0.3 * Math.sin(ph)]);
  rot('Neck', ['x', 1.0 * Math.sin(2 * ph + 0.6)]);
  rot('Head', ['y', 5 * Math.sin(ph)], ['x', 1.2 * Math.sin(2 * ph + 1)]);
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    // 足は床に着けたまま、腰の左右の動きを脚の傾きで吸収する
    const a = Math.atan2(0.008 * Math.sin(ph), HIP_H) / deg;
    rot(`Thigh.${s}`, ['z', a - sg * 0], ['x', -1.5]);
    rot(`Shin.${s}`, ['x', 3]);
    rot(`Foot.${s}`, ['z', -a], ['x', -1.5]);
    rot(`UpperArm.${s}`, ['x', 1.2 * Math.sin(2 * ph + sg)], ['z', sg * 2]);
    rot(`Forearm.${s}`, ['x', s === 'L' ? -10 : -5]);
  }
}

// 元の Walk / Idle を消して作り直す
for (const a of root.listAnimations()) if (a.getName() === 'Walk' || a.getName() === 'Idle') {
  a.dispose();
}
const buf = root.listBuffers()[0];
function makeClip(name, fn, length) {
  const n = Math.round(length * FPS);
  const times = new Float32Array(n + 1).map((_, f) => f / FPS);
  const input = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buf);
  const rotK = new Map(), trK = new Map();
  for (const j of joints) { rotK.set(j.getName(), new Float32Array((n + 1) * 4)); }
  trK.set('Hips', new Float32Array((n + 1) * 3));
  let prev = new Map();
  for (let f = 0; f <= n; f++) {
    fn(f === n ? 0 : f / FPS);             // 最後は最初と同じ姿勢
    for (const j of joints) {
      const nm = j.getName(), rest = restLocal.get(nm);
      const q = rest.q.clone().multiply(pose.get(nm)?.q || new Quaternion());
      const pq = prev.get(nm);
      if (pq && pq.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);   // 補間で遠回りしない
      prev.set(nm, q);
      rotK.get(nm).set(q.toArray(), f * 4);
    }
    const t = pose.get('Hips')?.t || [0, 0, 0];
    trK.get('Hips').set(restLocal.get('Hips').t.clone().add(v3(t)).toArray(), f * 3);
  }
  const anim = doc.createAnimation(name);
  for (const j of joints) {
    if (RIGID.has(j.getName())) continue;
    const out = doc.createAccessor().setType('VEC4').setArray(rotK.get(j.getName())).setBuffer(buf);
    const s = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR');
    anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(j).setTargetPath('rotation').setSampler(s));
  }
  const out = doc.createAccessor().setType('VEC3').setArray(trK.get('Hips')).setBuffer(buf);
  const s = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR');
  anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(J.Hips.node).setTargetPath('translation').setSampler(s));
  return anim;
}
makeClip('Walk', poseWalk, T);
makeClip('Idle', poseIdle, 4.0);
await io.write(out, doc);
console.log('written', out);
