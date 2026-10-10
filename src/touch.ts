/*
 * iPhone / iPad などのタッチ操作。
 * - 画面の左側: 指を置いた場所が中心の仮想スティック（倒した向きに歩く。端まで倒すと早歩き）
 * - 画面の右側: なぞった分だけ視点を回す
 * 2本の指を同時に使える（左で歩きながら右で見回す）。
 */

/** スティックを端まで倒したときの指の移動量（px） */
const STICK_R = 56;
/** 視点の回る速さ（ラジアン / px） */
const LOOK_SPEED = 0.0048;

export const isTouchDevice = () =>
  matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;

export class TouchControls {
  /** 前後（前が +）と左右（右が +）の入力。大きさは 0〜1 */
  f = 0;
  s = 0;
  /** スティックを端近くまで倒している（早歩き） */
  run = false;
  enabled = false;
  private stickId: number | null = null;
  private lookId: number | null = null;
  private origin = { x: 0, y: 0 };
  private last = { x: 0, y: 0 };
  private base: HTMLDivElement;
  private knob: HTMLDivElement;

  constructor(el: HTMLElement, private onLook: (dx: number, dy: number) => void) {
    this.base = document.createElement('div');
    this.base.className = 'stick';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    document.body.appendChild(this.base);
    const opt = { passive: false } as AddEventListenerOptions;
    el.addEventListener('touchstart', (e) => this.start(e), opt);
    el.addEventListener('touchmove', (e) => this.move(e), opt);
    el.addEventListener('touchend', (e) => this.end(e), opt);
    el.addEventListener('touchcancel', (e) => this.end(e), opt);
  }

  private start(e: TouchEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth * 0.45 && this.stickId === null) {
        this.stickId = t.identifier;
        this.origin = { x: t.clientX, y: t.clientY };
        this.base.style.left = `${t.clientX}px`;
        this.base.style.top = `${t.clientY}px`;
        this.base.classList.add('on');
        this.setStick(0, 0);
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.last = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private move(e: TouchEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.setStick(t.clientX - this.origin.x, t.clientY - this.origin.y);
      } else if (t.identifier === this.lookId) {
        this.onLook((t.clientX - this.last.x) * LOOK_SPEED, (t.clientY - this.last.y) * LOOK_SPEED);
        this.last = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private end(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = null;
        this.base.classList.remove('on');
        this.setStick(0, 0);
      } else if (t.identifier === this.lookId) {
        this.lookId = null;
      }
    }
  }

  private setStick(dx: number, dy: number) {
    const len = Math.hypot(dx, dy);
    const k = len > STICK_R ? STICK_R / len : 1;
    dx *= k; dy *= k;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // 中心付近の小さなぶれは無視する
    const m = Math.min(1, len / STICK_R);
    const a = m < 0.15 ? 0 : (m - 0.15) / 0.85;
    this.f = len ? (-dy / Math.hypot(dx, dy)) * a : 0;
    this.s = len ? (dx / Math.hypot(dx, dy)) * a : 0;
    this.run = m > 0.95;
  }

  /** 一時停止などで指の状態を捨てる */
  reset() {
    this.stickId = this.lookId = null;
    this.base.classList.remove('on');
    this.setStick(0, 0);
  }
}
