// 効果音もすべてWebAudioで合成する（音声ファイルなし）
export class Sound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private ambientGain: GainNode | null = null;

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // ブラウンノイズ寄り（空調の低いうなり）
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    this.noise = buf;

    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.35;
    this.ambientGain.connect(ctx.destination);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    src.connect(lp).connect(this.ambientGain);
    src.start();

    // 蛍光灯のかすかなハム
    const osc = ctx.createOscillator();
    osc.frequency.value = 100;
    const og = ctx.createGain();
    og.gain.value = 0.012;
    osc.connect(og).connect(this.ambientGain);
    osc.start();
  }

  setAmbient(v: number) {
    if (this.ambientGain && this.ctx) this.ambientGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  private burst(freq: number, q: number, dur: number, vol: number, rate = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(ctx.destination);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  step() {
    this.burst(900 + Math.random() * 300, 1.2, 0.09, 1.6, 4);
  }

  thud() {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.9);
  }

  /** しずくが水たまりに落ちる音（短く高い音が下がる） */
  drip(vol = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.type = 'sine';
    o.frequency.setValueAtTime(1500 + Math.random() * 300, t);
    o.frequency.exponentialRampToValueAtTime(520, t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.15);
  }

  flicker() {
    for (let i = 0; i < 6; i++) setTimeout(() => this.burst(3000, 4, 0.05, 0.6, 2), i * 180 + Math.random() * 80);
  }
}
