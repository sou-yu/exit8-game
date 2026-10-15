import shoesRun from './assets/sound/shoes_run.mp3?inline';
import shoesWalk from './assets/sound/shoes_walk.mp3?inline';
import dripUrl from './assets/sound/drip.mp3?inline';
import afterlifeUrl from './assets/sound/afterlife.mp3?inline';
import screamUrl from './assets/sound/scream.mp3?inline';
import ohashiUrl from './assets/sound/ohashi.wav?inline';

// 録音した音（8番出口/sound のファイル）。HTML に埋め込み、最初の再生時に読み込む
const FILES = {
  shoesRun, // 「革靴で走る」: ゆっくり移動するときの足音
  shoesWalk, // 「革靴で歩く」: 速く移動するときの足音
  drip: dripUrl, // 「水滴3」: 換気口の赤い液体が落ちる音
  afterlife: afterlifeUrl, // 「死後の世界」: 黒い人影に近づくほど大きくなる
  scream: screamUrl, // 「男性の悲鳴」: 少し開いたドアの奥を覗くと聞こえる
  ohashi: ohashiUrl, // 「お箸捨ててね」: 振り向くと後ろに立っているおばあさんの声
};
export type SoundName = keyof typeof FILES;

interface Loop { gain: GainNode; want: number; attack: number; release: number }

// 空調・蛍光灯・停電などは WebAudio で合成し、足音や異変の音は録音ファイルを鳴らす
export class Sound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private ambientGain: GainNode | null = null;
  private bufs = new Map<SoundName, AudioBuffer>();
  private loops = new Map<SoundName, Loop>();

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    for (const [name, url] of Object.entries(FILES) as [SoundName, string][]) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((d) => ctx.decodeAudioData(d))
        .then((b) => this.bufs.set(name, b))
        .catch(() => {});
    }
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

  /** 録音を一度鳴らす。鳴らせたら長さ（秒）、まだ読み込み中なら 0 を返す。pan: -1（左）〜 1（右） */
  play(name: SoundName, vol = 1, pan = 0): number {
    const ctx = this.ctx;
    const buf = this.bufs.get(name);
    if (!ctx || !buf) return 0;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan)) * 0.7;
    s.connect(g).connect(p).connect(ctx.destination);
    s.start();
    return buf.duration;
  }

  /**
   * 繰り返し鳴る録音の音量をこのフレームで指定する（毎フレーム呼ぶ）。
   * 呼ばれなかったフレームは音量 0 へ下がる。attack / release は音量が追いつく速さ（秒）
   */
  loop(name: SoundName, vol: number, attack = 0.05, release = 0.15) {
    const ctx = this.ctx;
    if (!ctx) return;
    let l = this.loops.get(name);
    if (!l) {
      const buf = this.bufs.get(name);
      if (!buf || vol <= 0) return;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      s.connect(gain).connect(ctx.destination);
      s.start();
      l = { gain, want: 0, attack, release };
      this.loops.set(name, l);
    }
    l.want = Math.max(l.want, vol);
    l.attack = attack;
    l.release = release;
  }

  /** フレームの最後に呼ぶ。loop() の指定を音量に反映する */
  endFrame() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const l of this.loops.values()) {
      const cur = l.gain.gain.value;
      l.gain.gain.setTargetAtTime(l.want, ctx.currentTime, l.want > cur ? l.attack : l.release);
      l.want = 0;
    }
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

  flicker() {
    for (let i = 0; i < 6; i++) setTimeout(() => this.burst(3000, 4, 0.05, 0.6, 2), i * 180 + Math.random() * 80);
  }
}
