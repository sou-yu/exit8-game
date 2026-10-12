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

  /**
   * 扉の奥からの、男性の低いうめき声（約2.6秒）。
   * 声帯の音（のこぎり波 約95Hz、ゆっくり下がる・小さく揺れる）を「お」に近い母音の響き（フォルマント）に通し、
   * 息の音を少し混ぜる。扉の向こうなので高い音を落とし、暗い部屋の短い残響を付ける。
   * vol: 0〜1、pan: -1（左）〜 1（右）
   */
  moan(vol = 1, pan = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime + 0.05;
    const D = 2.6 + Math.random() * 0.5;
    const f0 = 92 + Math.random() * 10;
    const out = ctx.createGain();
    out.gain.value = 0.7 * vol;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan)) * 0.7;
    // 扉の向こう: こもらせる
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 1300;
    muffle.Q.value = 0.5;
    muffle.connect(out).connect(panner).connect(ctx.destination);
    // 暗い部屋の短い残響
    const dl = ctx.createDelay(0.5);
    dl.delayTime.value = 0.11;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 700;
    muffle.connect(dl).connect(dlp).connect(fb).connect(dl);
    dlp.connect(panner);

    // 声の大きさ: ゆっくり出て、少しふくらんで、息が抜けるように消える
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + 0.35);
    env.gain.linearRampToValueAtTime(0.65, t + D * 0.45);
    env.gain.linearRampToValueAtTime(0.4, t + D * 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, t + D);
    // 母音「お〜う」の響き（第1・第2・第3フォルマント）
    const formants: [number, number, number, number][] = [
      // 周波数（始め→終わり）、Q、強さ
      [480, 380, 7, 1.0], [880, 760, 9, 0.45], [2500, 2400, 12, 0.07],
    ];
    for (const [fa, fb2, q, g] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(fa, t);
      bp.frequency.linearRampToValueAtTime(fb2, t + D);
      bp.Q.value = q;
      const gg = ctx.createGain();
      gg.gain.value = g * 2.2;
      env.connect(bp).connect(gg).connect(muffle);
    }
    // 胸に響く低い成分
    const chest = ctx.createBiquadFilter();
    chest.type = 'lowpass';
    chest.frequency.value = 260;
    const cg = ctx.createGain();
    cg.gain.value = 0.9;
    env.connect(chest).connect(cg).connect(muffle);
    // 声帯の音: 2本を少しずらして重ね、音程は少し上がってからゆっくり下がる
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.linearRampToValueAtTime(f0 * 1.08, t + 0.5);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.72, t + D);
      // 声の震え
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 4.5 + Math.random();
      const lg = ctx.createGain();
      lg.gain.value = f0 * 0.025;
      lfo.connect(lg).connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og).connect(env);
      o.start(t); lfo.start(t);
      o.stop(t + D + 0.1); lfo.stop(t + D + 0.1);
    }
    // 息の音
    const br = ctx.createBufferSource();
    br.buffer = this.noise;
    br.playbackRate.value = 3;
    const bbp = ctx.createBiquadFilter();
    bbp.type = 'bandpass';
    bbp.frequency.value = 700;
    bbp.Q.value = 0.8;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.12, t + 0.4);
    bg.gain.linearRampToValueAtTime(0.2, t + D * 0.85);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + D + 0.2);
    br.connect(bbp).connect(bg).connect(muffle);
    br.start(t, Math.random());
    br.stop(t + D + 0.3);
    // 鳴り終わったら残響の輪をほどく
    setTimeout(() => { fb.disconnect(); out.disconnect(); dlp.disconnect(); }, (D + 2) * 1000);
  }

  flicker() {
    for (let i = 0; i < 6; i++) setTimeout(() => this.burst(3000, 4, 0.05, 0.6, 2), i * 180 + Math.random() * 80);
  }
}
