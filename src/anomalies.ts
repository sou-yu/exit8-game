import * as THREE from 'three';
import * as T from './textures';
import { WALK_SPEED } from './man';
import { LM, LS, W, type World } from './world';

export interface Ctx {
  world: World;
  dt: number;
  px: number;
  pz: number;
  /** 判定通路に入ってからの経過時間（入っていなければ -1） */
  tInM: number;
  man: ManState;
  sound: (name: 'thud' | 'flicker' | 'drip' | 'moan', vol?: number, pan?: number) => void;
  /** カメラの向き（長さ 1） */
  look: THREE.Vector3;
  /** 球（中心・半径）が今の画面に少しでも入っているか */
  inView: (center: THREE.Vector3, radius: number) => boolean;
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
  w.mCeiling.position.y = 0;
  w.mHeaders.forEach((h) => (h.visible = false));
  w.hangingSign.position.y = w.hangingBaseY;
  w.man.setSmile(false);
  w.shadow.visible = false;
  w.leak.group.visible = false;
  w.hangingScrawl.visible = false;
  w.granny.group.visible = false;
  w.granny.bubble.visible = false;
  w.granny.setCastShadow(false);
  man.speed = WALK_SPEED;
  man.stare = false;
}

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

export const ANOMALIES: Anomaly[] = [
  {
    id: 'poster_eye', name: '眼科のポスターの目と文字が変わる', category: 'A',
    apply(w) {
      const p = w.posters.find((q) => q.kind === 'eye')!;
      (p.mesh.material as THREE.MeshStandardMaterial).map = poster('eye', true);
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
    // ドアの前まで来て、すき間の奥の暗がりを覗き込むと、男性の低いうめき声が聞こえる。覗き込んでいる間は間をおいて繰り返す
    id: 'door_open', name: 'ドアが少し開いている（覗き込むと、奥から男性のうめき声）', category: 'C',
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
        ctx.sound('moan', THREE.MathUtils.clamp(1.25 - dist * 0.35, 0.5, 1), right);
        mem.wait = 5 + Math.random() * 2.5;
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
      }
      g.mixer.update(ctx.dt);
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
      if (d < 7) {
        s.visible = false;
        ctx.sound('thud');
      }
    },
  },
];

export const ANOMALY_BY_ID = new Map(ANOMALIES.map((a) => [a.id, a]));
