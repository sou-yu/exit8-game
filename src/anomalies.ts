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
  sound: (name: 'thud' | 'flicker') => void;
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
function poster(kind: T.PosterKind, strange: boolean) {
  const key = kind + strange;
  if (!posterCache.has(key)) posterCache.set(key, T.posterTexture(kind, strange));
  return posterCache.get(key)!;
}
const hangTex = {
  normal: T.hangingSignTexture('normal'),
  reversed: T.hangingSignTexture('reversed'),
  goal: T.hangingSignTexture('goal'),
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
  w.mStripeMat.color.setHex(0x2a7d63);
  w.mCeiling.position.y = 0;
  w.mHeaders.forEach((h) => (h.visible = false));
  w.hangingSign.position.y = w.hangingBaseY;
  w.man.setSmile(false);
  w.shadow.visible = false;
  man.speed = WALK_SPEED;
  man.stare = false;
}

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
    id: 'stripe_red', name: '壁の帯が赤くなっている', category: 'A',
    apply(w) { w.mStripeMat.color.setHex(0x9e1d1d); },
  },
  {
    id: 'door_open', name: 'ドアが少し開いている', category: 'C',
    apply(w) { w.door.rotation.y = 0.75; },
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
    id: 'shadow', name: '通路の奥に黒い人影が立っている', category: 'D',
    apply(w) {
      w.shadow.visible = true;
      w.shadow.position.set(LS - W / 2 - 0.4, 0, -LM + 1.2);
    },
    update(ctx) {
      const s = ctx.world.shadow;
      if (!s.visible) return;
      const d = Math.hypot(ctx.px - s.position.x, ctx.pz - s.position.z);
      if (d < 7) {
        s.visible = false;
        ctx.sound('thud');
      }
    },
  },
];

export const ANOMALY_BY_ID = new Map(ANOMALIES.map((a) => [a.id, a]));
