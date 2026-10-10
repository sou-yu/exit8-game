import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { setMaxAnisotropy } from './pbr';
import type { LightPreset } from './lighting';

/*
 * 描画パイプライン
 *   シーン(HDR, MSAA) → GTAO(環境遮蔽) → Bloom(控えめ) → ACES Filmic + sRGB → (FXAA) → 色調・周辺減光・ディザ
 * 画質は 高品質 / 標準 / 軽量 の3段階。フレーム時間を見て自動で下げ、Qキーで手動切替もできる。
 */

export type Quality = 0 | 1 | 2; // 0=高品質 1=標準 2=軽量
export const QUALITY_LABEL = ['画質: 高品質', '画質: 標準', '画質: 軽量'];

interface Preset {
  /** 解像度の上限（devicePixelRatio に対する） */
  dpr: number;
  msaa: number;
  fxaa: boolean;
  gtao: boolean;
  bloom: boolean;
  light: LightPreset;
}
const PRESETS: Preset[] = [
  { dpr: 1.5, msaa: 4, fxaa: false, gtao: true, bloom: true, light: { rects: 4, shadows: 4, shadowSize: 1024 } },
  { dpr: 1.0, msaa: 0, fxaa: true, gtao: false, bloom: true, light: { rects: 2, shadows: 2, shadowSize: 512 } },
  { dpr: 0.85, msaa: 0, fxaa: true, gtao: false, bloom: false, light: { rects: 0, shadows: 0, shadowSize: 512 } },
];
/** 高品質でも描画する画素数の上限（4K 画面などで重くなりすぎないように） */
const MAX_PIXELS = 2560 * 1440;

/** 露出。白い壁が明るい灰〜白に写り、蛍光灯のカバーだけが飛ぶ程度 */
const EXPOSURE = 3.5;
const ENV_INTENSITY = 1.0;

/** 表示空間での色調整: 低めの彩度、陰は青みのある灰、白はわずかに冷たく。周辺減光とディザ */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    saturation: { value: 0.86 },
    vignette: { value: 0.2 },
    shadowTint: { value: new THREE.Vector3(-0.007, -0.001, 0.009) },
    highTint: { value: new THREE.Vector3(-0.002, 0.002, 0.006) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time;
    uniform float saturation;
    uniform float vignette;
    uniform vec3 shadowTint;
    uniform vec3 highTint;
    varying vec2 vUv;
    float rand( vec2 co ) { return fract( sin( dot( co, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, saturation );
      c += shadowTint * ( 1.0 - smoothstep( 0.0, 0.55, l ) ) + highTint * smoothstep( 0.45, 1.0, l );
      vec2 d = ( vUv - 0.5 ) * vec2( resolution.x / resolution.y, 1.0 );
      c *= 1.0 - vignette * smoothstep( 0.4, 1.15, length( d ) );
      float n = rand( gl_FragCoord.xy + fract( time ) * 61.0 ) + rand( gl_FragCoord.yx * 1.37 + fract( time * 1.7 ) * 37.0 ) - 1.0;
      c += n / 255.0;
      gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), 1.0 );
    }
  `,
};

export interface Stats { fps: number; ms: number; gpuMs: number; calls: number; tris: number; px: string }

interface LightingLike { setPreset(p: LightPreset): void; setEmissive(on: boolean): void; update(cam: THREE.Vector3): void }

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private gtao: GTAOPass;
  private bloom: UnrealBloomPass;
  private fxaa: FXAAPass;
  private grade: ShaderPass;
  private quality: Quality = 0;
  private applied = false;
  private frameMs = 16;
  private sampleFrames = 0;
  private sinceChange = 0;
  private lighting: LightingLike | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private queries: { q: WebGLQuery; busy: boolean }[] = [];
  autoQuality = true;
  measureGpu = false;
  readonly stats: Stats = { fps: 0, ms: 0, gpuMs: -1, calls: 0, tris: 0, px: '' };
  onQualityChange: (q: Quality) => void = () => {};

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    const gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = EXPOSURE;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap; // r186 では PCFSoft は廃止。shadow.radius でにじませる
    gl.info.autoReset = false;
    this.gl = gl;
    setMaxAnisotropy(gl.capabilities.getMaxAnisotropy());
    this.timerExt = gl.getContext().getExtension('EXT_disjoint_timer_query_webgl2');

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(gl, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.gtao = new GTAOPass(scene, camera, 1, 1);
    this.gtao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.6, thickness: 0.9, scale: 1.0, samples: 16 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.gtao.blendIntensity = 0.7;
    this.composer.addPass(this.gtao);
    // Bloom は蛍光灯のまわりのにじみだけ（レンズの散乱程度）。広いもやは出さない
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.03, 0, 2.0);
    (this.bloom.highPassUniforms as Record<string, THREE.IUniform>).smoothWidth.value = 2.0; // しきい値付近はなめらかに
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.45, 0.2, 0.08, 0.03];
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    addEventListener('resize', () => this.resize());
  }

  get dom() { return this.gl.domElement; }

  /** CPU 内蔵の GPU か（ブラウザが名前を明かす場合だけ判定できる） */
  get integratedGpu() {
    const ctx = this.gl.getContext();
    const ext = ctx.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    return /Intel|UHD|Iris|Radeon\(TM\) Graphics|Vega \d+ Graphics|Apple M|Mali|Adreno/i.test(name) && !/NVIDIA|GeForce|RTX|Radeon RX|Arc A/i.test(name);
  }
  get level() { return this.quality; }

  /** 照明（面光源・影の数）を画質に合わせて切り替える相手 */
  attach(lighting: LightingLike) {
    this.lighting = lighting;
    this.apply();
  }

  private resize() {
    const p = PRESETS[this.quality];
    let pr = Math.min(devicePixelRatio, p.dpr);
    const px = innerWidth * innerHeight * pr * pr;
    if (px > MAX_PIXELS) pr *= Math.sqrt(MAX_PIXELS / px);
    this.gl.setPixelRatio(pr);
    this.gl.setSize(innerWidth, innerHeight);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(innerWidth, innerHeight);
    this.grade.uniforms.resolution.value.set(innerWidth * pr, innerHeight * pr);
    this.stats.px = `${Math.round(innerWidth * pr)}x${Math.round(innerHeight * pr)}`;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  private apply() {
    const p = PRESETS[this.quality];
    this.gtao.enabled = p.gtao;
    this.bloom.enabled = p.bloom;
    this.fxaa.enabled = p.fxaa;
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples !== p.msaa) { rt.samples = p.msaa; rt.dispose(); }
    }
    this.gl.shadowMap.enabled = p.light.shadows > 0;
    this.lighting?.setPreset(p.light);
    this.resize();
    this.applied = true;
  }

  setQuality(q: Quality) {
    if (q === this.quality && this.applied) return;
    const shadowsBefore = PRESETS[this.quality].light.shadows > 0;
    this.quality = q;
    this.apply();
    if (shadowsBefore !== PRESETS[q].light.shadows > 0) {
      // 影の有無はシェーダーに埋め込まれるので、材質を作り直させる
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
      });
    }
    this.sinceChange = 0;
    this.sampleFrames = 0;
    this.onQualityChange(q);
  }

  cycleQuality() {
    this.autoQuality = false;
    this.setQuality(((this.quality + 1) % 3) as Quality);
  }

  /**
   * 通路そのものを写した環境マップで IBL を行う（反射・間接光が通路の色になる）。
   * 撮る間は蛍光灯の発光面を消す（器具の映り込みは面光源の反射で正しい位置に出るので、二重にしない）。
   */
  captureEnvironment(at: THREE.Vector3, hide: THREE.Object3D[], bounces = 2) {
    hide.forEach((o) => { o.userData.wasVisible = o.visible; o.visible = false; });
    this.lighting?.setEmissive(false);
    this.lighting?.update(at);
    this.composer.render(); // シャドウマップを一度作っておく
    const pmrem = new THREE.PMREMGenerator(this.gl);
    // 1回目は直接光だけの通路、2回目はそれを環境光にした通路を写す（白い壁どうしの照り返しを2回分入れる）
    for (let i = 0; i < bounces; i++) {
      const target = pmrem.fromScene(this.scene, 0.03, 0.05, 60, { position: at, size: 256 });
      this.envRT?.dispose();
      this.envRT = target;
      this.scene.environment = target.texture;
    }
    pmrem.dispose();
    this.lighting?.setEmissive(true);
    hide.forEach((o) => { o.visible = o.userData.wasVisible; });
  }

  /** シェーダーを先にまとめて作っておく（最初の数フレームのひっかかりを減らす） */
  async precompile() {
    try { await this.gl.compileAsync(this.scene, this.camera); } catch { /* 古いブラウザでは描画時に作る */ }
  }

  render(dt: number, envLevel: number, measure: boolean, time: number) {
    this.scene.environmentIntensity = ENV_INTENSITY * envLevel;
    this.grade.uniforms.time.value = time;
    this.gl.info.reset();
    const q = this.beginGpuTimer();
    this.composer.render(dt);
    this.endGpuTimer(q);
    this.stats.calls = this.gl.info.render.calls;
    this.stats.tris = this.gl.info.render.triangles;
    this.frameMs = this.frameMs * 0.95 + dt * 1000 * 0.05;
    this.stats.ms = this.frameMs;
    this.stats.fps = 1000 / this.frameMs;
    if (!measure || !this.autoQuality) return;
    // 平均フレーム時間が長ければ画質を一段下げる（上げ直しはしない）
    this.sampleFrames++;
    this.sinceChange += dt;
    if (this.sampleFrames > 120 && this.sinceChange > 4 && this.frameMs > 21 && this.quality < 2) {
      this.setQuality((this.quality + 1) as Quality);
    }
  }

  // ---- GPU時間（対応ブラウザのみ） ----
  private beginGpuTimer(): { q: WebGLQuery; busy: boolean } | null {
    const ext = this.timerExt;
    if (!ext || !this.measureGpu) return null;
    const ctx = this.gl.getContext() as WebGL2RenderingContext;
    this.pollGpuTimers(ctx);
    let slot = this.queries.find((s) => !s.busy);
    if (!slot) {
      if (this.queries.length >= 4) return null;
      slot = { q: ctx.createQuery()!, busy: false };
      this.queries.push(slot);
    }
    ctx.beginQuery(ext.TIME_ELAPSED_EXT, slot.q);
    slot.busy = true;
    return slot;
  }

  private endGpuTimer(slot: { q: WebGLQuery; busy: boolean } | null) {
    if (!slot || !this.timerExt) return;
    (this.gl.getContext() as WebGL2RenderingContext).endQuery(this.timerExt.TIME_ELAPSED_EXT);
  }

  private pollGpuTimers(ctx: WebGL2RenderingContext) {
    const disjoint = ctx.getParameter(this.timerExt!.GPU_DISJOINT_EXT);
    for (const s of this.queries) {
      if (!s.busy) continue;
      if (!ctx.getQueryParameter(s.q, ctx.QUERY_RESULT_AVAILABLE)) continue;
      const ns = ctx.getQueryParameter(s.q, ctx.QUERY_RESULT) as number;
      s.busy = false;
      if (!disjoint) this.stats.gpuMs = this.stats.gpuMs < 0 ? ns / 1e6 : this.stats.gpuMs * 0.9 + (ns / 1e6) * 0.1;
    }
  }
}
