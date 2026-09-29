import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Character } from './characters'

/**
 * Procedural karts and critter drivers (remix edition). Every static part is merged into one
 * vertex-coloured mesh per material — glossy clear-coat paint, soft sheened fur, glassy eyes,
 * chrome, rubber and emissive lamps — so a whole racer stays around a dozen draw calls. Separate
 * nodes exist only for animated parts: steering pivots, rolling wheels, the body (lean/squash),
 * the head (bob), the tail, a flapping scarf and the antenna pennant.
 */
export const TOON = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.02 })

/** Shared racer materials (vertex coloured, so one material serves every critter and kart). */
export const MAT = {
  paint: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.04, clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 1.1 }),
  paint2: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.04, clearcoat: 0.55, clearcoatRoughness: 0.22, side: THREE.DoubleSide }),
  matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0 }),
  chrome: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.16, metalness: 1, envMapIntensity: 1.3 }),
  rubber: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }),
  fur: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, sheen: 0.7, sheenRoughness: 0.45, sheenColor: new THREE.Color('#fff4f8'), envMapIntensity: 0.7 }),
  gloss: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }),
  glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
}
type MatKey = keyof typeof MAT

type V3 = [number, number, number]

export class Parts {
  private list: THREE.BufferGeometry[] = []

  /** `smooth` keeps each primitive's own normals instead of faceting the merged mesh. */
  constructor(private readonly smooth = false) {}

  get size(): number {
    return this.list.length
  }

  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone()
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale))
    g.applyMatrix4(m)
    const c = new THREE.Color(color)
    const n = g.getAttribute('position').count
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i += 1) {
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.list.push(g)
    return this
  }

  /** Capsule-ish limb between two points. */
  limb(a: V3, b: V3, r: number, color: THREE.ColorRepresentation, seg = 8): this {
    const va = new THREE.Vector3(...a)
    const vb = new THREE.Vector3(...b)
    const len = va.distanceTo(vb)
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 4, seg)
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize())
    const e = new THREE.Euler().setFromQuaternion(q)
    const mid = va.add(vb).multiplyScalar(0.5)
    return this.add(g, color, [mid.x, mid.y, mid.z], [e.x, e.y, e.z])
  }

  mesh(material: THREE.Material = TOON): THREE.Mesh {
    const merged = mergeGeometries(this.list, false)!
    if (!this.smooth) merged.computeVertexNormals()
    for (const g of this.list) g.dispose()
    this.list = []
    const mesh = new THREE.Mesh(merged, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }
}

/** One Parts list per shared material; `into` emits one mesh per used material. */
class Build {
  private readonly parts = new Map<MatKey, Parts>()

  p(k: MatKey): Parts {
    let p = this.parts.get(k)
    if (!p) this.parts.set(k, (p = new Parts(true)))
    return p
  }

  into(g: THREE.Object3D): THREE.Object3D {
    for (const [k, p] of this.parts) {
      if (!p.size) continue
      const m = p.mesh(MAT[k])
      if (k === 'glow') m.castShadow = false
      g.add(m)
    }
    this.parts.clear()
    return g
  }
}

const sph = (r: number, w = 22, h = 16) => new THREE.SphereGeometry(r, w, h)
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z)
const rbox = (x: number, y: number, z: number, r = 0.05, seg = 3) => new RoundedBoxGeometry(x, y, z, seg, Math.min(r, x / 2 - 0.001, y / 2 - 0.001, z / 2 - 0.001))
const cyl = (rt: number, rb: number, h: number, s = 18) => new THREE.CylinderGeometry(rt, rb, h, s)
const cone = (r: number, h: number, s = 14) => new THREE.ConeGeometry(r, h, s)
const torus = (r: number, t: number, arc = Math.PI * 2, rs = 8, ts = 24) => new THREE.TorusGeometry(r, t, rs, ts, arc)

const INK = '#2b1a2e'
const WHITE = '#fffaf2'
const PINK = '#ff9ec4'
const METAL = '#e8e2ee'

export type KartView = {
  root: THREE.Group
  /** Lean/squash node containing chassis + driver. */
  body: THREE.Group
  driver: THREE.Group
  head: THREE.Group
  tail?: THREE.Group
  /** Scarf ends that flutter with speed. */
  scarf?: THREE.Group
  /** Antenna pennant (sways). */
  flag?: THREE.Group
  frontPivots: THREE.Group[]
  wheels: THREE.Object3D[]
  /** Local positions of the rear wheel contact points (drift sparks). */
  sparkPoints: THREE.Vector3[]
  /** Local exhaust tips (boost flames). */
  exhausts: THREE.Vector3[]
  shield: THREE.Mesh
  shadow: THREE.Mesh
  /** Sugar-rush rainbow aura (hidden unless active). */
  aura: THREE.Mesh
}

export function bubbleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uPop: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      uniform float uTime;
      void main() {
        vec3 p = position * (1.0 + 0.035 * sin(uTime * 6.0 + position.y * 4.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      uniform float uTime; uniform float uPop;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
        vec3 a = vec3(0.55, 0.95, 1.0); vec3 b = vec3(1.0, 0.6, 0.9);
        vec3 col = mix(a, b, 0.5 + 0.5 * sin(vP.y * 3.0 + uTime * 2.0));
        float spec = pow(max(0.0, dot(reflect(-vV, vN), normalize(vec3(0.4, 0.8, 0.3)))), 24.0);
        float alpha = (0.08 + f * 0.75 + spec * 0.6) * (1.0 - uPop);
        gl_FragColor = vec4(col * (1.0 + f) + spec, alpha);
      }`,
  })
}

/** Rainbow shell for the Sugar Rush item. */
export function auraMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      uniform float uTime;
      vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), 1.6);
        vec3 col = hue(fract(vP.y * 0.35 + uTime * 0.8));
        gl_FragColor = vec4(col * (0.25 + f * 1.4), 1.0);
      }`,
  })
}

type Face = { eye: string; eyeR: number; eyeX: number; eyeY: number; eyeZ: number; sy?: number }

/** Big glassy cartoon eyes with iris, pupil and two catch-lights. */
function eyes(b: Build, f: Face): void {
  const { eyeR: r, eyeX: x0, eyeY: y, eyeZ: z } = f
  const sy = f.sy ?? 1.15
  for (const s of [1, -1]) {
    const x = s * x0
    const yaw = s * 0.32
    // Push features outward along the eye's facing so they sit on the curved face.
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    b.p('gloss').add(sph(r, 20, 14), WHITE, [x, y, z], [0, yaw, 0], [1, sy, 0.62])
    b.p('gloss').add(sph(r * 0.7, 18, 12), f.eye, [x + fx * r * 0.3, y - r * 0.08, z + fz * r * 0.3], [0, yaw, 0], [1, sy * 1.02, 0.5])
    b.p('gloss').add(sph(r * 0.4, 14, 10), INK, [x + fx * r * 0.42, y - r * 0.1, z + fz * r * 0.42], [0, yaw, 0], [1, sy, 0.42])
    b.p('glow').add(sph(r * 0.2, 8, 6), '#ffffff', [x + fx * r * 0.58 + r * 0.22, y + r * 0.3, z + fz * r * 0.58], [0, 0, 0], [1, 1, 0.5])
    b.p('glow').add(sph(r * 0.1, 6, 4), '#ffffff', [x + fx * r * 0.56 - r * 0.2, y - r * 0.3, z + fz * r * 0.56], [0, 0, 0], [1, 1, 0.5])
  }
}

/** Content closed eyes (^ ^). */
function happyEyes(b: Build, x0: number, y: number, z: number, r = 0.075): void {
  for (const s of [1, -1]) b.p('gloss').add(torus(r, 0.018, Math.PI, 6, 14), INK, [s * x0, y, z], [0, s * 0.3, 0])
}

function smile(b: Build, y: number, z: number, w = 0.06, color = INK): void {
  b.p('gloss').add(torus(w, 0.016, Math.PI, 6, 16), color, [0, y, z], [0.15, 0, Math.PI])
}

function blush(b: Build, x: number, y: number, z: number): void {
  for (const s of [1, -1]) b.p('matte').add(sph(0.075, 12, 8), PINK, [s * x, y, z], [0, s * 0.5, 0], [1.1, 0.6, 0.35])
}

/** Aviator goggles resting on the forehead. */
function goggles(b: Build, y: number, z: number, lens: string, spread = 0.15, head: [number, number] = [1, 1], strap = '#5a3a2a'): void {
  // Strap hugs the (scaled) head sphere at the lens height.
  const by = y - 0.02
  const r = 0.5 * Math.sqrt(Math.max(0.05, 1 - (by / (0.5 * head[1])) ** 2)) * 1.015
  b.p('matte').add(torus(r, 0.022, Math.PI * 2, 6, 40), strap, [0, by, 0], [Math.PI / 2, 0, 0], [head[0], 1, 1])
  for (const s of [1, -1]) {
    b.p('chrome').add(torus(0.1, 0.028, Math.PI * 2, 8, 20), METAL, [s * spread, y, z], [-0.55, s * 0.28, 0])
    b.p('gloss').add(sph(0.095, 16, 10), lens, [s * spread, y, z], [-0.55, s * 0.28, 0], [1, 1, 0.35])
  }
}

/** Driver torso + head for one species (also used for portraits). */
function buildDriver(c: Character): { driver: THREE.Group; head: THREE.Group; tail?: THREE.Group; scarf: THREE.Group } {
  const driver = new THREE.Group()
  const t = new Build()
  // Torso in a little racing vest, arms reaching for the wheel, gloved paws.
  t.p('fur').add(sph(0.42), c.fur, [0, 0.95, -0.32], [0, 0, 0], [1, 1.05, 0.9])
  t.p('fur').add(sph(0.3), c.belly, [0, 0.92, -0.1], [0, 0, 0], [1, 1.1, 0.5])
  t.p('matte').add(sph(0.44, 22, 12, ), c.kartAccent, [0, 0.9, -0.34], [0, 0, 0], [1.02, 0.8, 0.92])
  t.p('matte').add(rbox(0.12, 0.34, 0.06, 0.03), WHITE, [0.2, 0.92, 0.04], [0.15, 0.3, 0])
  t.p('matte').add(rbox(0.12, 0.34, 0.06, 0.03), WHITE, [-0.2, 0.92, 0.04], [0.15, -0.3, 0])
  t.p('matte').add(torus(0.28, 0.085, Math.PI * 2, 10, 28), c.kartAccent, [0, 1.25, -0.28], [Math.PI / 2, 0, 0])
  t.p('matte').add(sph(0.1, 12, 10), c.kartAccent, [0.12, 1.2, -0.02], [0, 0, 0], [1, 0.8, 0.7])
  for (const s of [1, -1]) {
    t.p('fur').limb([s * 0.34, 1.08, -0.22], [s * 0.19, 0.99, 0.24], 0.1, c.fur)
    t.p('matte').add(sph(0.115, 14, 10), WHITE, [s * 0.17, 0.98, 0.31], [0, 0, 0], [1, 0.9, 1.1])
    t.p('matte').add(torus(0.1, 0.03, Math.PI * 2, 6, 14), c.kartAccent, [s * 0.18, 0.99, 0.22], [0.2, 0, 0])
  }
  t.into(driver)

  // Scarf tails behind the neck (animated).
  const scarf = new THREE.Group()
  scarf.position.set(0.1, 1.24, -0.58)
  const sc = new Build()
  sc.p('matte').add(rbox(0.16, 0.05, 0.42, 0.02), c.kartAccent, [0, 0, -0.2], [0.1, 0.15, 0])
  sc.p('matte').add(rbox(0.14, 0.05, 0.34, 0.02), c.kartAccent, [-0.12, -0.04, -0.15], [0.2, -0.2, 0])
  sc.p('matte').add(box(0.17, 0.052, 0.04), WHITE, [0, 0.0, -0.36], [0.1, 0.15, 0])
  sc.into(scarf)
  driver.add(scarf)

  const head = new THREE.Group()
  head.position.set(0, 1.58, -0.24)
  const h = new Build()
  const fur = h.p('fur')
  let tail: THREE.Group | undefined
  switch (c.id) {
    case 'hamster':
      fur.add(sph(0.5, 28, 20), c.fur, [0, 0, 0], [0, 0, 0], [1.08, 0.95, 1])
      fur.add(sph(0.22), c.belly, [0.3, -0.14, 0.2], [0, 0, 0], [1, 0.85, 0.9])
      fur.add(sph(0.22), c.belly, [-0.3, -0.14, 0.2], [0, 0, 0], [1, 0.85, 0.9])
      fur.add(sph(0.25), c.belly, [0, -0.12, 0.33], [0, 0, 0], [1.1, 0.75, 0.62])
      fur.add(sph(0.12), c.belly, [0, 0.2, 0.34], [0, 0, 0], [1.4, 0.6, 0.5])
      for (const s of [1, -1]) {
        fur.add(sph(0.16), c.furDark, [s * 0.33, 0.38, -0.02], [0, 0, s * -0.3], [1, 1, 0.45])
        h.p('matte').add(sph(0.1), PINK, [s * 0.33, 0.38, 0.03], [0, 0, s * -0.3], [1, 1, 0.3])
      }
      eyes(h, { eye: c.eye, eyeR: 0.09, eyeX: 0.18, eyeY: 0.06, eyeZ: 0.4 })
      h.p('gloss').add(sph(0.055, 14, 10), '#ff6f91', [0, -0.04, 0.53], [0, 0, 0], [1.2, 0.85, 0.8])
      smile(h, -0.13, 0.5, 0.05)
      h.p('matte').add(rbox(0.07, 0.07, 0.03, 0.01), WHITE, [0, -0.2, 0.495])
      blush(h, 0.31, -0.1, 0.36)
      goggles(h, 0.28, 0.37, '#ffb13b', 0.15, [1.08, 0.95])
      break
    case 'hedgehog': {
      fur.add(sph(0.48, 28, 20), c.fur, [0, 0, 0])
      fur.add(sph(0.31), c.belly, [0, -0.08, 0.26], [0, 0, 0], [1.1, 0.9, 0.9])
      fur.add(sph(0.15), c.belly, [0, -0.1, 0.5], [0, 0, 0], [1, 0.82, 1.4])
      h.p('gloss').add(sph(0.068, 14, 10), INK, [0, -0.08, 0.71])
      eyes(h, { eye: c.eye, eyeR: 0.085, eyeX: 0.17, eyeY: 0.08, eyeZ: 0.39 })
      smile(h, -0.2, 0.47, 0.045)
      blush(h, 0.29, -0.13, 0.33)
      // Soft spikes over the back of the head, in two staggered rings.
      for (let ring = 0; ring < 3; ring += 1) {
        const n = 12 - ring * 2
        for (let i = 0; i < n; i += 1) {
          const a = (i / n) * Math.PI * 2 + ring * 0.4
          const dir = new THREE.Vector3(Math.cos(a) * (0.95 - ring * 0.25), Math.sin(a) * (0.95 - ring * 0.25) + 0.3 + ring * 0.12, -0.55 - ring * 0.35).normalize()
          if (dir.z > 0.1) continue
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
          const e = new THREE.Euler().setFromQuaternion(q)
          const p = dir.clone().multiplyScalar(0.44)
          fur.add(cone(0.11, 0.44 - ring * 0.04, 10), ring === 1 ? c.furDark : '#6b4632', [p.x, p.y, p.z], [e.x, e.y, e.z])
          h.p('matte').add(sph(0.022, 6, 4), '#fff2e0', [p.x + dir.x * 0.22, p.y + dir.y * 0.22, p.z + dir.z * 0.22])
        }
      }
      for (const s of [1, -1]) fur.add(sph(0.1), c.furDark, [s * 0.3, 0.36, 0.05], [0, 0, 0], [1, 1, 0.5])
      // Sporty headband.
      h.p('matte').add(torus(0.462, 0.04, Math.PI * 2, 8, 40), c.kartAccent, [0, 0.15, 0], [Math.PI / 2, 0, 0])
      h.p('matte').add(sph(0.07, 10, 8), c.kartAccent, [0.2, 0.15, -0.42])
      break
    }
    case 'sloth':
      fur.add(sph(0.5, 28, 20), c.fur, [0, 0, 0], [0, 0, 0], [1.02, 0.96, 1])
      fur.add(sph(0.36), c.belly, [0, -0.02, 0.2], [0, 0, 0], [1.2, 0.95, 0.85])
      for (const s of [1, -1]) fur.add(sph(0.13), c.furDark, [s * 0.19, 0.01, 0.42], [0, 0, s * 0.45], [1.55, 0.75, 0.45])
      happyEyes(h, 0.2, 0.02, 0.495, 0.065)
      h.p('gloss').add(sph(0.07, 14, 10), '#3b2a22', [0, -0.12, 0.53], [0, 0, 0], [1.25, 0.8, 0.8])
      smile(h, -0.22, 0.49, 0.07, '#3b2a22')
      blush(h, 0.33, -0.16, 0.37)
      fur.add(cone(0.12, 0.3, 12), c.furDark, [0.05, 0.5, -0.02], [0.4, 0, 0.3])
      // Sprout on top of the head.
      h.p('matte').add(cyl(0.015, 0.02, 0.22, 6), '#4f9c3a', [-0.1, 0.56, 0.02], [0, 0, 0.2])
      h.p('gloss').add(sph(0.1, 14, 8), '#7ed957', [-0.19, 0.66, 0.02], [0, 0.3, 0.7], [1.6, 0.25, 0.9])
      h.p('gloss').add(sph(0.08, 14, 8), '#98ea6e', [-0.02, 0.68, 0.02], [0, -0.3, -0.6], [1.5, 0.25, 0.85])
      break
    case 'redpanda':
      fur.add(sph(0.5, 28, 20), c.fur, [0, 0, 0], [0, 0, 0], [1.1, 0.95, 1])
      fur.add(sph(0.26), c.belly, [0, -0.14, 0.34], [0, 0, 0], [1.2, 0.75, 0.6])
      for (const s of [1, -1]) {
        fur.add(cone(0.17, 0.32, 16), c.fur, [s * 0.34, 0.43, -0.02], [0, 0, -s * 0.35])
        h.p('matte').add(cone(0.1, 0.2, 12), WHITE, [s * 0.33, 0.41, 0.06], [0, 0, -s * 0.35])
        fur.add(sph(0.065), WHITE, [s * 0.2, 0.22, 0.42])
        fur.add(sph(0.16), WHITE, [s * 0.32, -0.08, 0.28], [0, s * 0.4, 0], [1, 0.8, 0.6])
        fur.add(sph(0.12), c.furDark, [s * 0.2, -0.2, 0.33], [0, 0, 0], [0.7, 1.2, 0.5])
      }
      eyes(h, { eye: c.eye, eyeR: 0.088, eyeX: 0.19, eyeY: 0.06, eyeZ: 0.41 })
      h.p('gloss').add(sph(0.058, 14, 10), INK, [0, -0.08, 0.56], [0, 0, 0], [1.25, 0.85, 0.8])
      smile(h, -0.17, 0.52, 0.05)
      goggles(h, 0.33, 0.32, '#5fd6ff', 0.16, [1.1, 0.95], '#3b1a12')
      break
    case 'bunny':
      fur.add(sph(0.48, 28, 20), c.fur, [0, 0, 0], [0, 0, 0], [1, 0.98, 1])
      fur.add(sph(0.24), c.belly, [0, -0.14, 0.32], [0, 0, 0], [1.2, 0.75, 0.6])
      for (const s of [1, -1]) {
        fur.add(new THREE.CapsuleGeometry(0.11, 0.62, 6, 14), c.fur, [s * 0.17, 0.72, -0.1], [-0.25, 0, -s * 0.18])
        h.p('matte').add(new THREE.CapsuleGeometry(0.06, 0.5, 6, 12), PINK, [s * 0.17, 0.72, -0.03], [-0.25, 0, -s * 0.18], [1, 1, 0.45])
      }
      // Ribbon bow on the right ear.
      h.p('gloss').add(sph(0.1, 12, 8), c.kartAccent, [0.3, 0.52, -0.02], [0, 0, 0.6], [1.3, 0.7, 0.5])
      h.p('gloss').add(sph(0.1, 12, 8), c.kartAccent, [0.1, 0.56, -0.02], [0, 0, -0.6], [1.3, 0.7, 0.5])
      h.p('gloss').add(sph(0.05, 10, 8), '#ffffff', [0.2, 0.54, 0.02])
      eyes(h, { eye: c.eye, eyeR: 0.09, eyeX: 0.17, eyeY: 0.06, eyeZ: 0.39 })
      h.p('gloss').add(sph(0.05, 12, 8), '#ff6f91', [0, -0.07, 0.5], [0, 0, 0], [1.2, 0.85, 0.8])
      smile(h, -0.15, 0.47, 0.045)
      h.p('matte').add(rbox(0.1, 0.09, 0.03, 0.012), WHITE, [0, -0.21, 0.46])
      blush(h, 0.29, -0.11, 0.35)
      break
    case 'frog':
      fur.add(sph(0.5, 28, 20), c.fur, [0, 0, 0], [0, 0, 0], [1.25, 0.78, 1])
      fur.add(sph(0.36), c.belly, [0, -0.2, 0.18], [0, 0, 0], [1.35, 0.5, 0.9])
      for (const s of [1, -1]) fur.add(sph(0.19), c.fur, [s * 0.25, 0.3, 0.05])
      eyes(h, { eye: c.eye, eyeR: 0.13, eyeX: 0.25, eyeY: 0.34, eyeZ: 0.26, sy: 1 })
      h.p('gloss').add(torus(0.2, 0.02, Math.PI, 6, 24), '#2d5c2a', [0, -0.02, 0.468], [0.25, 0, Math.PI], [1.15, 0.5, 1])
      h.p('gloss').add(sph(0.06, 12, 8), '#ff7fa8', [0.07, -0.11, 0.47], [0.3, 0, 0], [1, 0.5, 0.8])
      blush(h, 0.36, -0.06, 0.4)
      for (const [x, y, z] of [[0.3, 0.05, 0.36], [-0.34, 0.1, 0.32], [0.1, 0.28, -0.3], [-0.2, 0.24, -0.34]] as V3[]) fur.add(sph(0.04, 8, 6), c.furDark, [x, y, z])
      break
  }
  h.into(head)
  driver.add(head)

  if (c.id === 'redpanda') {
    tail = new THREE.Group()
    tail.position.set(0, 0.8, -0.95)
    const tb = new Build()
    for (let i = 0; i < 8; i += 1) {
      const k = i / 7
      tb.p('fur').add(sph(0.2 - k * 0.05, 16, 12), i % 2 === 0 ? c.fur : c.furDark, [0, k * 0.6, -0.1 - Math.sin(k * 2.2) * 0.38], [0, 0, 0], [1, 0.95, 1])
    }
    tb.into(tail)
    driver.add(tail)
  } else if (c.id === 'bunny' || c.id === 'hamster') {
    const tb = new Build()
    tb.p('fur').add(sph(c.id === 'bunny' ? 0.14 : 0.09, 14, 10), c.id === 'bunny' ? WHITE : c.furDark, [0, 0.82, -0.72])
    tb.into(driver)
  }
  return { driver, head, tail, scarf }
}

/** Tyre with a rounded shoulder and tread blocks plus a glossy spoked rim. */
function makeWheel(r: number, w: number, rim: string): THREE.Group {
  const g = new THREE.Group()
  const b = new Build()
  const ri = r * 0.64
  const c = Math.min(0.08, w * 0.3)
  const pts: THREE.Vector2[] = [new THREE.Vector2(ri, -w / 2)]
  for (let i = 0; i <= 5; i += 1) {
    const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2)
    pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, -w / 2 + c + Math.sin(a) * c))
  }
  for (let i = 0; i <= 5; i += 1) {
    const a = (i / 5) * (Math.PI / 2)
    pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, w / 2 - c + Math.sin(a) * c))
  }
  pts.push(new THREE.Vector2(ri, w / 2))
  b.p('rubber').add(new THREE.LatheGeometry(pts, 26), '#352431', [0, 0, 0], [0, 0, Math.PI / 2])
  for (let i = 0; i < 18; i += 1) {
    const a = (i / 18) * Math.PI * 2
    b.p('rubber').add(box(w * 0.7, 0.03, 0.07), '#2a1c26', [0, Math.cos(a) * (r - 0.004), Math.sin(a) * (r - 0.004)], [a, 0, 0])
  }
  b.p('paint').add(cyl(ri, ri, w * 0.82, 22), rim, [0, 0, 0], [0, 0, Math.PI / 2])
  b.p('paint').add(cyl(ri * 0.8, ri * 0.8, w * 0.86, 22), '#fff4f8', [0, 0, 0], [0, 0, Math.PI / 2])
  for (let i = 0; i < 5; i += 1) b.p('paint').add(box(w * 0.9, ri * 1.45, 0.07), rim, [0, 0, 0], [(i / 5) * Math.PI, 0, 0])
  b.p('paint').add(cyl(ri * 0.3, ri * 0.3, w * 0.94, 14), WHITE, [0, 0, 0], [0, 0, Math.PI / 2])
  b.p('paint').add(cyl(ri * 0.12, ri * 0.12, w * 0.98, 10), INK, [0, 0, 0], [0, 0, Math.PI / 2])
  b.into(g)
  return g
}

export function buildKart(c: Character): KartView {
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)

  const kc = c.kart
  const ac = c.kartAccent
  const DARK = '#3b2a36'
  const b = new Build()
  const paint = b.p('paint')
  // Chassis tray + rounded tub.
  b.p('matte').add(rbox(1.22, 0.14, 2.35, 0.06), DARK, [0, 0.3, 0.02])
  paint.add(rbox(1.02, 0.38, 1.75, 0.16), kc, [0, 0.5, -0.02])
  // Nose: ellipsoid shell with a centre racing stripe and a paw emblem.
  paint.add(sph(0.5, 28, 18), kc, [0, 0.5, 0.9], [0, 0, 0], [1, 0.52, 1.25])
  paint.add(sph(0.5, 28, 18), ac, [0, 0.505, 0.9], [0, 0, 0], [0.3, 0.535, 1.265])
  paint.add(cyl(0.11, 0.11, 0.03, 18), WHITE, [0, 0.738, 1.2], [0.24, 0, 0])
  for (const [x, dz] of [[-0.1, 0.1], [0, 0.14], [0.1, 0.1]] as [number, number][]) paint.add(cyl(0.038, 0.038, 0.03, 10), WHITE, [x, 0.72, 1.2 + dz + 0.02], [0.26, 0, 0])
  // Front bumper, splitter and headlights.
  paint.add(new THREE.CapsuleGeometry(0.09, 1.2, 4, 12), ac, [0, 0.3, 1.5], [0, 0, Math.PI / 2])
  b.p('matte').add(rbox(1.46, 0.05, 0.34, 0.02), DARK, [0, 0.22, 1.4])
  for (const s of [1, -1]) {
    b.p('glow').add(sph(0.075, 14, 10), '#fff3cf', [s * 0.3, 0.57, 1.36], [0, 0, 0], [1, 1, 0.6])
    b.p('chrome').add(torus(0.085, 0.022, Math.PI * 2, 6, 18), METAL, [s * 0.3, 0.57, 1.36], [0, s * 0.35, 0])
  }
  // Side pods with intakes and a white number roundel.
  for (const s of [1, -1]) {
    paint.add(rbox(0.3, 0.32, 1.15, 0.13), ac, [s * 0.66, 0.44, -0.1])
    b.p('matte').add(rbox(0.2, 0.16, 0.06, 0.03), INK, [s * 0.66, 0.46, 0.48])
    paint.add(cyl(0.12, 0.12, 0.03, 20), WHITE, [s * 0.815, 0.46, -0.12], [0, 0, Math.PI / 2])
    paint.add(cyl(0.07, 0.07, 0.034, 16), kc, [s * 0.817, 0.46, -0.12], [0, 0, Math.PI / 2])
  }
  // Padded cockpit rim, seat and dashboard.
  b.p('matte').add(torus(0.4, 0.07, Math.PI * 2, 10, 32), DARK, [0, 0.7, -0.26], [Math.PI / 2, 0, 0], [1, 1.35, 1])
  b.p('matte').add(rbox(0.8, 0.74, 0.18, 0.08), '#4a2f3c', [0, 0.96, -0.72], [-0.12, 0, 0])
  paint.add(rbox(0.84, 0.07, 0.2, 0.03), ac, [0, 1.33, -0.77], [-0.12, 0, 0])
  b.p('matte').add(rbox(0.72, 0.16, 0.3, 0.06), DARK, [0, 0.74, 0.34])
  b.p('glow').add(cyl(0.055, 0.055, 0.02, 14), c.ui, [0.17, 0.83, 0.38], [-0.5, 0, 0])
  b.p('glow').add(cyl(0.04, 0.04, 0.02, 12), '#9ff4ff', [-0.17, 0.83, 0.38], [-0.5, 0, 0])
  // Steering column and wheel.
  b.p('chrome').limb([0, 0.72, 0.5], [0, 0.96, 0.3], 0.03, METAL)
  b.p('matte').add(torus(0.2, 0.042, Math.PI * 2, 8, 28), INK, [0, 0.98, 0.28], [-0.55, 0, 0])
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    const x = Math.sin(a) * 0.1
    const y = Math.cos(a) * 0.1
    b.p('chrome').add(box(0.03, 0.2, 0.02), METAL, [x * Math.cos(0.55), 0.98 + y * Math.cos(0.55), 0.28 - y * Math.sin(0.55)], [-0.55, 0, -a])
  }
  paint.add(sph(0.055, 12, 8), ac, [0, 0.98, 0.28], [-0.55, 0, 0], [1, 1, 0.5])
  // Engine block, cylinder heads, exhausts.
  b.p('matte').add(rbox(0.88, 0.42, 0.5, 0.09), '#6a4a5a', [0, 0.62, -1.0])
  for (const x of [-0.24, 0, 0.24]) b.p('chrome').add(cyl(0.085, 0.085, 0.2, 14), METAL, [x, 0.9, -1.0])
  for (const x of [-0.24, 0, 0.24]) b.p('chrome').add(torus(0.085, 0.015, Math.PI * 2, 4, 14), METAL, [x, 0.95, -1.0], [Math.PI / 2, 0, 0])
  for (const s of [1, -1]) {
    b.p('chrome').add(cyl(0.085, 0.105, 0.5, 14), METAL, [s * 0.3, 0.8, -1.26], [-1.1, 0, 0])
    b.p('chrome').add(cyl(0.12, 0.095, 0.12, 14), METAL, [s * 0.3, 0.9, -1.48], [-1.1, 0, 0])
    b.p('matte').add(cyl(0.075, 0.075, 0.02, 12), INK, [s * 0.3, 0.925, -1.535], [-1.1, 0, 0])
  }
  // Rear wing on struts with end plates.
  for (const s of [1, -1]) {
    paint.add(rbox(0.07, 0.5, 0.14, 0.03), ac, [s * 0.46, 1.04, -1.1], [0.12, 0, 0])
    paint.add(rbox(0.05, 0.24, 0.46, 0.02), ac, [s * 0.8, 1.31, -1.12], [0.12, 0, 0])
  }
  paint.add(rbox(1.56, 0.09, 0.44, 0.04), kc, [0, 1.3, -1.12], [0.12, 0, 0])
  paint.add(rbox(1.56, 0.02, 0.1, 0.008), WHITE, [0, 1.35, -0.99], [0.12, 0, 0])
  // Rear bumper + tail lights.
  b.p('matte').add(new THREE.CapsuleGeometry(0.08, 1.0, 4, 12), DARK, [0, 0.34, -1.34], [0, 0, Math.PI / 2])
  for (const s of [1, -1]) b.p('glow').add(rbox(0.16, 0.06, 0.03, 0.02), '#ff4f6d', [s * 0.38, 0.52, -1.27])
  // Suspension arms to the wheel hubs.
  for (const [x, y, z] of [[0.8, 0.33, 0.78], [0.82, 0.39, -0.78]] as V3[]) {
    for (const s of [1, -1]) b.p('chrome').limb([s * 0.42, 0.34, z], [s * (x - 0.12), y, z], 0.035, METAL, 6)
  }
  b.into(body)

  // Antenna pennant.
  const flag = new THREE.Group()
  flag.position.set(-0.55, 0.62, -1.2)
  const fb = new Build()
  fb.p('chrome').limb([0, 0, 0], [0, 1.25, -0.1], 0.012, METAL, 5)
  fb.p('paint2').add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 0.26), new THREE.Vector2(-0.42, 0.13)])), c.ui, [0, 1.0, -0.08], [0, Math.PI / 2, 0])
  fb.p('gloss').add(sph(0.035, 10, 8), ac, [0, 1.26, -0.1])
  fb.into(flag)
  body.add(flag)

  const { driver, head, tail, scarf } = buildDriver(c)
  body.add(driver)

  const wheels: THREE.Object3D[] = []
  const frontPivots: THREE.Group[] = []
  for (const s of [1, -1]) {
    const pivot = new THREE.Group()
    pivot.position.set(s * 0.8, 0.33, 0.78)
    const w = makeWheel(0.33, 0.3, ac)
    pivot.add(w)
    // Fender that steers with the wheel.
    const fender = new Build()
    fender.p('paint2').add(new THREE.CylinderGeometry(0.43, 0.43, 0.36, 20, 1, true, Math.PI * 0.1, Math.PI * 0.72), kc, [0, 0.02, 0], [0, 0, Math.PI / 2])
    fender.into(pivot)
    root.add(pivot)
    frontPivots.push(pivot)
    wheels.push(w)
    const rear = makeWheel(0.39, 0.42, ac)
    rear.position.set(s * 0.82, 0.39, -0.78)
    root.add(rear)
    wheels.push(rear)
  }

  const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1.75, 3), bubbleMaterial())
  shield.position.y = 0.95
  shield.visible = false
  root.add(shield)

  const aura = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 3), auraMaterial())
  aura.position.y = 0.9
  aura.scale.set(1, 0.85, 1.25)
  aura.visible = false
  root.add(aura)

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.25, 24),
    new THREE.MeshBasicMaterial({ color: '#2b1430', transparent: true, opacity: 0.32, depthWrite: false }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.scale.set(0.85, 1.25, 1)
  shadow.renderOrder = 1

  return {
    root,
    body,
    driver,
    head,
    tail,
    scarf,
    flag,
    frontPivots,
    wheels,
    sparkPoints: [new THREE.Vector3(0.82, 0.05, -1.05), new THREE.Vector3(-0.82, 0.05, -1.05)],
    exhausts: [new THREE.Vector3(0.3, 0.95, -1.55), new THREE.Vector3(-0.3, 0.95, -1.55)],
    shield,
    shadow,
    aura,
  }
}

let studioEnv: { gl: THREE.WebGLRenderer; tex: THREE.Texture } | undefined
/** Neutral studio reflections (portraits and as a fallback before the sky is baked). */
export function studioEnvironment(gl: THREE.WebGLRenderer): THREE.Texture {
  if (studioEnv?.gl === gl) return studioEnv.tex
  const pmrem = new THREE.PMREMGenerator(gl)
  const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()
  studioEnv = { gl, tex }
  return tex
}

/** Head-and-shoulders portraits for UI cards, rendered once with the game renderer. */
export function renderPortraits(gl: THREE.WebGLRenderer, roster: Character[], size = 192): Map<string, string> {
  const out = new Map<string, string>()
  const scene = new THREE.Scene()
  scene.environment = studioEnvironment(gl)
  scene.environmentIntensity = 0.55
  scene.add(new THREE.HemisphereLight('#fff4f8', '#8a6a9a', 1.3))
  const key = new THREE.DirectionalLight('#fff0e0', 2.6)
  key.position.set(2, 3, 4)
  const rim = new THREE.DirectionalLight('#c9b6ff', 2.2)
  rim.position.set(-3, 2, -3)
  scene.add(key, rim)
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20)
  cam.position.set(0.9, 1.78, 3.2)
  cam.lookAt(0, 1.4, 0)
  const target = new THREE.WebGLRenderTarget(size, size, { samples: 4 })
  target.texture.colorSpace = THREE.SRGBColorSpace
  const pixels = new Uint8Array(size * size * 4)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const prevTarget = gl.getRenderTarget()
  const prevClear = gl.getClearColor(new THREE.Color())
  const prevAlpha = gl.getClearAlpha()
  const prevTone = gl.toneMapping
  gl.setClearColor(0x000000, 0)
  for (const c of roster) {
    const { driver } = buildDriver(c)
    driver.rotation.y = 0.35
    scene.add(driver)
    gl.setRenderTarget(target)
    gl.clear()
    gl.render(scene, cam)
    gl.readRenderTargetPixels(target, 0, 0, size, size, pixels)
    const img = ctx.createImageData(size, size)
    for (let y = 0; y < size; y += 1) {
      const src = (size - 1 - y) * size * 4
      img.data.set(pixels.subarray(src, src + size * 4), y * size * 4)
    }
    ctx.clearRect(0, 0, size, size)
    ctx.putImageData(img, 0, 0)
    out.set(c.id, canvas.toDataURL('image/png'))
    scene.remove(driver)
    driver.traverse(o => (o as THREE.Mesh).geometry?.dispose())
  }
  gl.setRenderTarget(prevTarget)
  gl.setClearColor(prevClear, prevAlpha)
  gl.toneMapping = prevTone
  target.dispose()
  return out
}
