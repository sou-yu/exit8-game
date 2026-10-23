import * as THREE from 'three';
import * as T from './textures';
import { MAN_SPEED } from './man';
import { canStand, LM, LS, W, type World } from './world';
import { PENGUIN_COUNT, type PenguinPose } from './penguins';

export interface Ctx {
  world: World;
  dt: number;
  px: number;
  pz: number;
  /** 判定通路に入ってからの経過時間（入っていなければ -1） */
  tInM: number;
  man: ManState;
  /** 一度鳴らす。録音の音は長さ（秒、読み込み中なら 0）を返す */
  sound: (name: 'thud' | 'flicker' | 'drip' | 'scream' | 'ohashi', vol?: number, pan?: number) => number | void;
  /** 繰り返し鳴る音の音量をこのフレームで指定する。呼ばないフレームは小さくなって消える */
  loop: (name: 'afterlife', vol: number) => void;
  /** カメラの向き（長さ 1） */
  look: THREE.Vector3;
  /** 球（中心・半径）が今の画面に少しでも入っているか */
  inView: (center: THREE.Vector3, radius: number) => boolean;
  /** 捕まった: 0番の最初の場所に戻す */
  caught: () => void;
}

export interface ManState {
  z: number;
  walking: boolean;
  visible: boolean;
  speed: number;
  stare: boolean;
}

export interface Anomaly {
  id: string;
  name: string;
  category: 'A' | 'B' | 'C' | 'D';
  apply(w: World, man: ManState): void;
  update?(ctx: Ctx, mem: Record<string, number>): void;
}

const posterCache = new Map<string, THREE.Texture>();
function poster(kind: T.PosterKind, strange: boolean | 'phone') {
  const key = kind + strange;
  if (!posterCache.has(key)) posterCache.set(key, T.posterTexture(kind, strange));
  return posterCache.get(key)!;
}
const hangTex = {
  normal: T.hangingSignTexture('normal'),
  reversed: T.hangingSignTexture('reversed'),
  goal: T.hangingSignTexture('goal'),
  goalReversed: T.hangingSignTexture('goalReversed'),
};

export function setHangingSign(w: World, mode: keyof typeof hangTex) {
  const mats = w.hangingSign.material as THREE.MeshStandardMaterial[];
  mats[4].map = mats[4].emissiveMap = hangTex[mode];
  mats[4].needsUpdate = true;
}

/** 通常状態に戻す */
export function resetWorld(w: World, man: ManState) {
  w.posters.forEach((p) => {
    const m = p.mesh.material as THREE.MeshStandardMaterial;
    m.map = poster(p.kind, false);
  });
  w.eyeIris.position.copy(w.eyeIrisBase);
  setHangingSign(w, 'normal');
  w.lamps.forEach((l) => {
    l.visible = true;
    l.level = 1;
    l.yOffset = 0;
  });
  w.lighting.emergency = 0;
  w.envLevel = 1;
  w.door.rotation.y = 0;
  w.tracks.group.visible = false;
  w.penguins.group.visible = false;
  w.mCeiling.position.y = 0;
  w.mHeaders.forEach((h) => (h.visible = false));
  w.hangingSign.position.y = w.hangingBaseY;
  w.man.setSmile(false);
  w.man.group.scale.setScalar(1);
  w.shadow.visible = false;
  w.leak.group.visible = false;
  w.hangingScrawl.visible = false;
  w.granny.group.visible = false;
  w.granny.bubble.visible = false;
  w.granny.setCastShadow(false);
  w.tileMan.group.visible = false;
  w.tileMan.group.position.copy(w.tileManHome);
  w.tileMan.group.rotation.y = Math.PI / 2;
  w.tileMan.rest();
  man.speed = MAN_SPEED;
  man.stare = false;
}

/** 巨大化したおじさんの大きさの倍率（身長 約 1.75m → 約 2.6m。天井は 2.8m、出口案内の板の下端は約 2.1m） */
const MAN_GIANT = 1.5;
/** 耳タイルマン: 歩き出す距離、追いかける速さ（早歩き 3.0 m/秒より少し遅い）、速さに届くまでの時間、捕まる距離 */
const TILE_WAKE = 3.5, TILE_SPEED = 2.5, TILE_ACCEL = 1.2, TILE_CATCH = 0.55;
/** 目が追う異変: プレイヤーの目の高さ、黒目が動ける楕円の半径（横・縦）、追う速さ */
const EYE_Y = 1.6;
const GAZE_RZ = 0.2, GAZE_RY = 0.045;
const GAZE_FOLLOW = 5;
/** おばあさんが立つ位置: プレイヤーの真後ろ（来た方向、+z）にこの距離 */
/** うめき声: すき間の中心（扉の中心から z 方向へのずれ）、聞こえる距離と見る向きの幅 */
const DOOR_GAP_DZ = 0.3;
const PEER_DIST = 1.9;
const PEER_ANGLE = 0.5;
const gapAt = new THREE.Vector3();
const GRANNY_BEHIND = 1.25;
/** おばあさんの体と吹き出しを包む球（足もとからの高さと半径）。回り込むときは、この球が画面の外にあること */
const GRANNY_SPHERE_Y = 0.95, GRANNY_SPHERE_R = 1.0;
/** 「見た」とみなす球（体の中心あたり）。画面の端にかすっただけでは数えない */
const GRANNY_SEEN_R = 0.5;
const grannyAt = new THREE.Vector3();

/** ペンギンの群れ: 判定通路に入ってから走ってくるまでの秒数、走る速さ（早歩き 3.0 m/秒なら逃げられる）、速さに届くまでの時間、
 *  1 秒の歩数（左右 1 歩ずつで 1）、ぶつかる距離、仲間との間隔 */
const PENG_DELAY = 5, PENG_SPEED = 2.4, PENG_ACCEL = 0.8, PENG_STEPS = 2.6, PENG_CATCH = 0.5, PENG_GAP = 0.55;
const flock: (PenguinPose & { v: number; vmax: number; lane: number })[] = [];

export const ANOMALIES: Anomaly[] = [
  {
    // 眼科ポスターの黒目が、白目の中を動いていつもプレイヤーのほうを見ている
    id: 'poster_gaze', name: '眼科のポスターの目が、こちらを目で追ってくる', category: 'A',
    apply() {},
    update(ctx) {
      const w = ctx.world;
      const b = w.eyeIrisBase;
      const dx = ctx.px - b.x, dy = EYE_Y - b.y, dz = ctx.pz - b.z;
      const d = Math.hypot(dx, dy, dz);
      // 白目の中で動ける幅（横 z と縦 y）。はみ出さないよう楕円の中に収める
      let oz = (dz / d) * GAZE_RZ * 1.6, oy = (dy / d) * GAZE_RY * 3;
      const e = Math.hypot(oz / GAZE_RZ, oy / GAZE_RY);
      if (e > 1) { oz /= e; oy /= e; }
      const k = 1 - Math.exp(-GAZE_FOLLOW * ctx.dt);
      w.eyeIris.position.z += (b.z + oz - w.eyeIris.position.z) * k;
      w.eyeIris.position.y += (b.y + oy - w.eyeIris.position.y) * k;
    },
  },
  {
    id: 'sign_arrow', name: '出口案内の矢印が逆を向いている', category: 'A',
    apply(w) { setHangingSign(w, 'reversed'); },
  },
  {
    id: 'lamp_missing', name: '照明が1本足りない', category: 'A',
    apply(w) {
      const l = w.lamps.filter((q) => q.inM)[3];
      l.visible = false;
      l.level = 0;
    },
  },
  {
    id: 'penguin_tracks', name: '通路の床一面に、ペンギンの濡れた足跡がたくさん続いている', category: 'A',
    apply(w) { w.tracks.group.visible = true; },
  },
  {
    // 判定通路に入ってしばらくすると、奥の待合からペンギンの群れが角を曲がって走ってくる。ぶつかると 0番に戻される
    id: 'penguin_rush', name: 'しばらくすると、通路の奥からペンギンの群れが走ってくる', category: 'D',
    apply() {},
    update(ctx, mem) {
      const pg = ctx.world.penguins;
      if (!mem.started) {
        if (ctx.tInM < PENG_DELAY) return;
        mem.started = 1;
        // 奥の待合（通路の角の先、判定通路からは見えない所）に群れを並べる
        flock.length = 0;
        for (let i = 0; i < PENGUIN_COUNT; i++) {
          const col = i % 6, row = Math.floor(i / 6);
          flock.push({
            x: LS + 0.7 + col * 1.0 + (Math.random() - 0.5) * 0.4,
            z: -LM - 0.5 - row * 0.62 - (Math.random() - 0.5) * 0.2,
            yaw: -Math.PI / 2, scale: 0.85 + Math.random() * 0.2, phase: Math.random() * 6.28, run: 0,
            v: 0, vmax: PENG_SPEED * (0.85 + Math.random() * 0.3), lane: (Math.random() - 0.5) * (W - 1.2),
          });
        }
        pg.group.visible = true;
      }
      for (const p of flock) {
        // 待合にいるうちは通路の入口へ、通路に入ったらプレイヤーへ向かう（並ぶ位置は少しずつばらける）
        const inM = p.z > -LM + 0.4 || p.x < LS - 0.3;
        const tx = inM ? ctx.px : LS - W / 2 + p.lane, tz = inM ? ctx.pz : -LM + 1.5;
        let dx = tx - p.x, dz = tz - p.z;
        const d = Math.hypot(dx, dz) || 1;
        if (inM && d < PENG_CATCH * p.scale) {
          ctx.sound('thud');
          ctx.caught();
          return;
        }
        dx /= d; dz /= d;
        // 近くの仲間とは少し離れる
        for (const o of flock) {
          if (o === p) continue;
          const ox = p.x - o.x, oz = p.z - o.z, od = Math.hypot(ox, oz);
          if (od > 0 && od < PENG_GAP) { dx += (ox / od) * (PENG_GAP - od) * 2.5; dz += (oz / od) * (PENG_GAP - od) * 2.5; }
        }
        const target = Math.atan2(dx, dz);
        let diff = target - p.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        p.yaw += diff * (1 - Math.exp(-ctx.dt / 0.18));
        p.v = Math.min(p.vmax, p.v + (p.vmax / PENG_ACCEL) * ctx.dt);
        const mx = Math.sin(p.yaw) * p.v * ctx.dt, mz = Math.cos(p.yaw) * p.v * ctx.dt;
        if (canStand(p.x + mx, p.z, 0.2)) p.x += mx;
        if (canStand(p.x, p.z + mz, 0.2)) p.z += mz;
        p.run = p.v / p.vmax;
        p.phase += ctx.dt * Math.PI * 2 * PENG_STEPS * (0.4 + 0.6 * p.run) / p.scale;
      }
      pg.update(flock);
    },
  },
  {
    // ドアの前まで来て、すき間の奥の暗がりを覗き込むと、男性の悲鳴が聞こえる。覗き込んでいる間は間をおいて繰り返す
    id: 'door_open', name: 'ドアが少し開いている（覗き込むと、奥から男性の悲鳴）', category: 'C',
    apply(w) { w.door.rotation.y = 0.75; },
    update(ctx, mem) {
      const v = ctx.world.doorVoid.position;
      // 開いた扉に隠れていない、すき間の真ん中あたり
      gapAt.set(v.x, 1.2, v.z - DOOR_GAP_DZ);
      const dx = gapAt.x - ctx.px, dz = gapAt.z - ctx.pz;
      const dist = Math.hypot(dx, dz);
      const lookLen = Math.hypot(ctx.look.x, ctx.look.z);
      const cos = lookLen > 1e-3 ? (dx * ctx.look.x + dz * ctx.look.z) / (dist * lookLen) : 0;
      const peering = dist < PEER_DIST && dx > 0.2 && cos > Math.cos(PEER_ANGLE) && ctx.inView(gapAt, 0.15);
      mem.wait = Math.max(0, (mem.wait ?? 0) - ctx.dt);
      if (!peering) {
        mem.peer = 0;
        return;
      }
      mem.peer = (mem.peer ?? 0) + ctx.dt;
      // 覗き込んで少したってから。一度鳴ったら次まで間をおく
      if (mem.peer > 0.4 && mem.wait === 0) {
        const right = (dz * ctx.look.x - dx * ctx.look.z) / (dist * Math.max(lookLen, 1e-3)); // 声のする向き（右が +）
        const len = ctx.sound('scream', THREE.MathUtils.clamp(1.25 - dist * 0.35, 0.5, 1), right) || 0;
        mem.wait = len + 3 + Math.random() * 2.5;
      }
    },
  },
  {
    id: 'ceiling_low', name: '通路の天井が低い', category: 'C',
    apply(w) {
      const d = 0.6;
      w.mCeiling.position.y = -d;
      w.mHeaders.forEach((h) => (h.visible = true));
      w.lamps.filter((l) => l.inM).forEach((l) => { l.yOffset = -d; });
      w.hangingSign.position.y = w.hangingBaseY - d;
    },
  },
  {
    id: 'man_smile', name: '通行人が満面の笑みを浮かべている', category: 'B',
    apply(w) { w.man.setSmile(true); },
  },
  {
    // 通行人のおじさんが、天井に頭が届きそうなほど大きい（歩幅も大きいので、少し速く歩いてくる）。
    // 頭が出口案内の板より高いので、板の手前で立ち止まり、こちらへ向き直って見下ろす
    id: 'man_giant', name: '通行人のおじさんが巨大化している', category: 'B',
    apply(w, man) {
      w.man.group.scale.setScalar(MAN_GIANT);
      man.speed = MAN_SPEED * 1.2;
    },
    update(ctx) {
      const stopZ = ctx.world.hangingSign.position.z - 1;
      if (ctx.man.z > stopZ) {
        ctx.man.z = stopZ;
        ctx.man.walking = false;
      }
    },
  },
  {
    id: 'man_stare', name: '通行人が立ち止まってこちらを見つめる', category: 'B',
    apply(_w, man) { man.stare = true; },
  },
  {
    id: 'blackout', name: '通路の途中で停電する', category: 'D',
    apply() {},
    update(ctx, mem) {
      const w = ctx.world;
      if (!mem.started && ctx.pz < -13) {
        mem.started = 1;
        mem.t = 0;
        ctx.sound('flicker');
      }
      if (!mem.started) return;
      mem.t += ctx.dt;
      if (mem.t < 1.4) {
        // 蛍光灯がまたたく（器具ごとに少しずつずれる）
        w.lamps.forEach((l, i) => {
          if (l.inM) l.level = Math.random() > 0.42 + (i % 3) * 0.06 ? 1 : 0.04;
        });
      } else if (!mem.dark) {
        mem.dark = 1;
        ctx.sound('thud');
        w.lamps.forEach((l) => (l.level = 0));
        w.envLevel = 0.12;
      }
      // 停電から少し遅れて非常灯が点く
      if (mem.dark) w.lighting.emergency = Math.min(1, Math.max(0, (mem.t - 1.9) / 0.4));
    },
  },
  {
    id: 'poster_phone', name: '眼科のポスターの電話番号が「03-1133-315」になっている', category: 'A',
    apply(w) {
      const p = w.posters.find((q) => q.kind === 'eye')!;
      (p.mesh.material as THREE.MeshStandardMaterial).map = poster('eye', 'phone');
    },
  },
  {
    id: 'poster_bath', name: '銭湯のポスターの「みなと湯」が「みみの湯」になっている', category: 'A',
    apply(w) {
      const p = w.posters.find((q) => q.kind === 'bath')!;
      (p.mesh.material as THREE.MeshStandardMaterial).map = poster('bath', true);
    },
  },
  {
    id: 'poster_manner', name: 'マナーポスターの人の頭が首から離れている', category: 'A',
    apply(w) {
      const p = w.posters.find((q) => q.kind === 'manner')!;
      (p.mesh.material as THREE.MeshStandardMaterial).map = poster('manner', true);
    },
  },
  {
    id: 'sign_scrawl', name: '出口案内の裏に「戻れ！戻れ！戻れ！」と書いてある', category: 'A',
    apply(w) { w.hangingScrawl.visible = true; },
  },
  {
    id: 'vent_blood', name: '換気口から赤い液体が垂れ、床に水たまりができている', category: 'D',
    apply(w) { w.leak.group.visible = true; },
    update(ctx) {
      const d = ctx.world.leak.update(ctx.dt, ctx.px, ctx.pz);
      // しずくの落ちる音（近いほど大きい）
      if (d !== null && d < 14) ctx.sound('drip', Math.min(1, 2.5 / Math.max(1, d)));
    },
  },
  {
    // 前を向いて進んでいる間は見えない。振り向くと、すぐ後ろでこちらを見て立っていて、吹き出しで話しかけてくる。
    // 目をそらすとまた真後ろへ回り込むので、何度振り向いても同じように立っている
    id: 'granny_behind', name: '振り向くと、すぐ後ろにおばあさんが立っていて「お箸捨ててね」と話しかけてくる', category: 'B',
    apply() {},
    update(ctx, mem) {
      const g = ctx.world.granny;
      const grp = g.group;
      const seen = () => ctx.inView(grannyAt.set(grp.position.x, GRANNY_SPHERE_Y, grp.position.z), GRANNY_SEEN_R);
      const maybeSeen = () => ctx.inView(grannyAt.set(grp.position.x, GRANNY_SPHERE_Y, grp.position.z), GRANNY_SPHERE_R);
      mem.voiceWait = Math.max(0, (mem.voiceWait ?? 0) - ctx.dt);
      if (mem.shown && !(grp.visible && seen())) {
        // 目をそらした
        mem.shown = 0;
        g.bubble.visible = false;
        g.setCastShadow(false); // 後ろについている間は、影が前に落ちて見えないようにする
      }
      if (!mem.shown) {
        // 判定通路の中だけ。真後ろの位置が画面の外にあるうちに、そこへ回り込む
        const tx = THREE.MathUtils.clamp(ctx.px, LS - W + 0.45, LS - 0.45);
        const tz = ctx.pz + GRANNY_BEHIND;
        const inside = ctx.tInM >= 0 && ctx.pz < -3 && tz < -1.6;
        if (inside && !ctx.inView(grannyAt.set(tx, GRANNY_SPHERE_Y, tz), GRANNY_SPHERE_R)) {
          grp.position.set(tx, 0, tz);
          grp.visible = true;
        } else if (!inside && grp.visible && !maybeSeen()) {
          grp.visible = false;
        }
        if (grp.visible && seen()) {
          // 振り向いた
          mem.shown = 1;
          mem.t = 0;
          mem.spoke = 0;
          g.setCastShadow(true);
        }
      }
      if (!grp.visible) return;
      // いつもこちらを見ている
      grp.rotation.y = Math.atan2(ctx.px - grp.position.x, ctx.pz - grp.position.z);
      if (mem.shown) {
        // 少し間をおいて吹き出しが出る
        mem.t += ctx.dt;
        const k = THREE.MathUtils.clamp((mem.t - 0.35) / 0.15, 0, 1);
        g.bubble.visible = k > 0;
        g.bubble.scale.set(0.6 * (0.6 + 0.4 * k), 0.25 * (0.6 + 0.4 * k), 1);
        g.bubble.material.opacity = k;
        // 吹き出しが出ると同時に「お箸捨ててね」と話しかけてくる（前の声がまだ続いていれば重ねない）
        if (k > 0 && !mem.spoke) {
          mem.spoke = 1;
          if (mem.voiceWait === 0) mem.voiceWait = ctx.sound('ohashi') || 0;
        }
      }
      g.mixer.update(ctx.dt);
    },
  },
  {
    // 壁のタイル柄に擬態して壁際に立っている。近づくと歩き出して追いかけてくる。追いつかれると 0番に戻される
    id: 'tile_man', name: '壁のタイルに擬態した耳タイルマンが立っていて、近づくと追いかけてくる', category: 'D',
    apply(w) { w.tileMan.group.visible = true; },
    update(ctx, mem) {
      const t = ctx.world.tileMan;
      const g = t.group;
      const dx = ctx.px - g.position.x, dz = ctx.pz - g.position.z;
      const d = Math.hypot(dx, dz);
      if (!mem.chase && d < TILE_WAKE && ctx.tInM >= 0) {
        mem.chase = 1;
        mem.v = 0;
        ctx.sound('thud', 0.7);
      }
      if (!mem.chase) return;
      if (d < TILE_CATCH) {
        ctx.sound('thud');
        ctx.caught();
        return;
      }
      // こちらへ向き直りながら、だんだん速くなって追ってくる（通路の幅からははみ出さない）
      mem.v = Math.min(TILE_SPEED, (mem.v ?? 0) + (TILE_SPEED / TILE_ACCEL) * ctx.dt);
      const target = Math.atan2(dx, dz);
      let diff = target - g.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      g.rotation.y += diff * (1 - Math.exp(-ctx.dt / 0.15));
      const step = Math.min(mem.v * ctx.dt, d);
      g.position.x = THREE.MathUtils.clamp(g.position.x + (dx / d) * step, LS - W + 0.3, LS - 0.3);
      g.position.z += (dz / d) * step;
      t.animate(ctx.dt, mem.v);
    },
  },
  {
    id: 'shadow', name: '通路の奥に黒い人影が膝を抱えて座っている', category: 'D',
    apply(w) {
      w.shadow.visible = true;
      w.shadow.position.set(LS - W / 2 - 0.4, 0, -LM + 1.2);
    },
    update(ctx) {
      const s = ctx.world.shadow;
      if (!s.visible) return;
      s.rotation.y = Math.atan2(ctx.px - s.position.x, ctx.pz - s.position.z); // 板をいつもこちらへ向ける
      const d = Math.hypot(ctx.px - s.position.x, ctx.pz - s.position.z);
      // 近づくほど「死後の世界」が大きく聞こえてくる
      const k = THREE.MathUtils.clamp((30 - d) / (30 - 7), 0, 1);
      ctx.loop('afterlife', 0.08 + 0.92 * k * k);
      if (d < 7) {
        s.visible = false;
        ctx.sound('thud');
      }
    },
  },
];

export const ANOMALY_BY_ID = new Map(ANOMALIES.map((a) => [a.id, a]));
