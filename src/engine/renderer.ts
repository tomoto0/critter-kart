import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { Quality } from './save'

type Preset = { pixelRatio: number; shadows: boolean; shadowMap: number; bloom: boolean; post: boolean; samples: number; antialias: boolean }

export const QUALITY_PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1, shadows: false, shadowMap: 512, bloom: false, post: false, samples: 0, antialias: false },
  medium: { pixelRatio: 1.5, shadows: true, shadowMap: 1024, bloom: true, post: true, samples: 2, antialias: true },
  high: { pixelRatio: 2, shadows: true, shadowMap: 2048, bloom: true, post: true, samples: 4, antialias: true },
}

/** Pick a starting quality from device hints; the player can override it in Settings. */
export function suggestQuality(): Quality {
  const coarse = matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency ?? 4
  if (coarse || cores <= 4) return 'medium'
  return 'high'
}

/**
 * Final colour grade in display space: gentle S-curve, saturation lift, warm highlights / cool
 * shadows, a soft vignette and an edge zoom-streak while boosting.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.3 },
    uBoost: { value: 0 },
    uSat: { value: 1.14 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVignette; uniform float uBoost; uniform float uSat;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c * vec2(1.25, 1.0));
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      if (uBoost > 0.001) {
        vec3 acc = col;
        float k = 0.012 * uBoost * smoothstep(0.15, 0.7, r);
        for (int i = 1; i <= 4; i++) acc += texture2D(tDiffuse, vUv - c * float(i) * k).rgb;
        col = acc / 5.0;
      }
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.2);
      col += vec3(0.03, 0.01, -0.018) * smoothstep(0.45, 1.0, l);
      col += vec3(-0.008, 0.0, 0.026) * (1.0 - smoothstep(0.0, 0.35, l));
      float v = smoothstep(0.95, 0.25, r);
      col *= mix(1.0 - uVignette, 1.0, v);
      col = mix(col, col * vec3(1.03, 0.94, 1.07), uBoost * smoothstep(0.3, 0.9, r) * 0.6);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
}

/**
 * Owns the WebGL renderer, the optional post-processing chain and resize handling.
 * Scenes call `render(scene, camera)`; they never touch the composer directly.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer
  private composer?: EffectComposer
  private bloom?: UnrealBloomPass
  private grade?: ShaderPass
  private preset: Preset
  private scene?: THREE.Scene
  private camera?: THREE.PerspectiveCamera
  /** 0..1 boost intensity fed to the grade pass. */
  boost = 0

  constructor(readonly canvas: HTMLCanvasElement, quality: Quality) {
    this.preset = QUALITY_PRESETS[quality]
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: this.preset.antialias, powerPreference: 'high-performance' })
    this.gl.outputColorSpace = THREE.SRGBColorSpace
    this.gl.toneMapping = THREE.ACESFilmicToneMapping
    this.gl.toneMappingExposure = 0.97
    this.gl.shadowMap.type = THREE.PCFShadowMap
    this.applyQuality(quality)
    window.addEventListener('resize', () => this.resize())
  }

  get shadowMapSize(): number {
    return this.preset.shadowMap
  }

  applyQuality(quality: Quality): void {
    this.preset = QUALITY_PRESETS[quality]
    this.gl.shadowMap.enabled = this.preset.shadows
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.preset.pixelRatio))
    this.bloom?.dispose()
    this.composer?.dispose()
    this.composer = undefined
    this.bloom = undefined
    this.grade = undefined
    this.resize()
  }

  private ensureComposer(scene: THREE.Scene, camera: THREE.PerspectiveCamera): EffectComposer | undefined {
    if (!this.preset.post) return undefined
    if (this.composer && this.scene === scene && this.camera === camera) return this.composer
    this.scene = scene
    this.camera = camera
    const size = this.gl.getSize(new THREE.Vector2())
    const pr = this.gl.getPixelRatio()
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr), { type: THREE.HalfFloatType, samples: this.preset.samples })
    this.composer = new EffectComposer(this.gl, rt)
    this.composer.setPixelRatio(pr)
    this.composer.addPass(new RenderPass(scene, camera))
    if (this.preset.bloom) {
      this.bloom = new UnrealBloomPass(size, 0.34, 0.45, 1.12)
      this.composer.addPass(this.bloom)
    }
    this.composer.addPass(new OutputPass())
    this.grade = new ShaderPass(GradeShader)
    this.composer.addPass(this.grade)
    this.composer.setSize(size.x, size.y)
    return this.composer
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.gl.setSize(w, h, false)
    this.composer?.setPixelRatio(this.gl.getPixelRatio())
    this.composer?.setSize(w, h)
    if (this.camera) {
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    if (Math.abs(camera.aspect - w / h) > 1e-3) {
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const composer = this.ensureComposer(scene, camera)
    if (composer) {
      if (this.grade) {
        const u = this.grade.uniforms as typeof GradeShader.uniforms
        u.uBoost.value += (this.boost - u.uBoost.value) * 0.12
      }
      composer.render()
    } else this.gl.render(scene, camera)
  }
}
