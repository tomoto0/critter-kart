import * as THREE from 'three'
import { Parts } from './kartModel'
import { SHORT_WALL, WALL, type Track } from './track'

/**
 * Sugarloop Valley scenery (remix edition): a painted sky dome with wispy clouds and a sun halo,
 * a warm key light that follows the camera, smooth rolling meadows with a fine grass texture,
 * glossy soda lakes with lily pads, instanced candy flora (swirl lollipops, cotton-candy trees,
 * gumdrops, candy canes, mushrooms, marshmallows, flowers and grass tufts), distant cupcake
 * mountains and a candy castle, a spinning windmill, drifting hot-air balloons, a frosted donut
 * arch, the start gantry with bunting and bouncing critter fans. Everything is procedural; one
 * seeded RNG keeps the layout identical between sessions.
 */
export type Scenery = {
  sun: THREE.DirectionalLight
  startLights: THREE.Mesh[]
  update(time: number, dt: number, focus: THREE.Vector3): void
  setShadowMap(size: number): void
  /** Bake the sky into an environment map for glossy reflections. */
  bakeEnvironment(gl: THREE.WebGLRenderer): void
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(x: number, z: number): number {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return h - Math.floor(h)
}
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const xf = x - xi
  const zf = z - zi
  const u = xf * xf * (3 - 2 * xf)
  const v = zf * zf * (3 - 2 * zf)
  const a = hash2(xi, zi)
  const b = hash2(xi + 1, zi)
  const c = hash2(xi, zi + 1)
  const d = hash2(xi + 1, zi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
function fbm(x: number, z: number): number {
  return vnoise(x, z) * 0.55 + vnoise(x * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, z * 4.3) * 0.15
}

/** Non-indexed copy that keeps smooth normals and paints each face by `fn(centroid)`. */
function faceColors(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => THREE.Color): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  const pos = g.getAttribute('position')
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3
    const c = fn(x, y, z)
    for (let k = 0; k < 3; k += 1) col.set([c.r, c.g, c.b], (i + k) * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  if (g.getAttribute('uv')) g.deleteAttribute('uv')
  return g
}

const LAKES = [
  { x: -112, z: -108, r: 21 },
  { x: 47, z: -64, r: 10 },
  { x: 60, z: 40, r: 26 },
]

/** Spatial hash of centre-line samples for fast "distance to the road" queries. */
class RoadField {
  private cells = new Map<string, { x: number; z: number; y: number; w: number }[]>()
  constructor(track: Track, private readonly size = 12) {
    for (const [sp, w] of [[track.main, WALL], [track.short, SHORT_WALL]] as const) {
      for (let i = 0; i < sp.samples.length; i += 2) {
        const p = sp.samples[i].pos
        const k = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`
        let list = this.cells.get(k)
        if (!list) this.cells.set(k, (list = []))
        list.push({ x: p.x, z: p.z, y: p.y, w })
      }
    }
  }
  /** Distance beyond the wall line (negative = inside the road) and the road height there. */
  query(x: number, z: number, reach = 3): { d: number; y: number } {
    const cx = Math.floor(x / this.size)
    const cz = Math.floor(z / this.size)
    let best = Infinity
    let y = 0
    for (let i = -reach; i <= reach; i += 1)
      for (let j = -reach; j <= reach; j += 1) {
        const list = this.cells.get(`${cx + i},${cz + j}`)
        if (!list) continue
        for (const p of list) {
          const d = Math.hypot(p.x - x, p.z - z) - p.w
          if (d < best) {
            best = d
            y = p.y
          }
        }
      }
    return { d: best, y }
  }
}

const SKY_VERT = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`
const SKY_FRAG = /* glsl */ `varying vec3 vDir; uniform vec3 uSun; uniform float uTime;
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float n2(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5; float s = 0.0; for (int i = 0; i < 5; i++) { s += a * n2(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
  void main(){
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -0.2, 1.0);
    vec3 top = vec3(0.38, 0.55, 1.0);
    vec3 mid = vec3(0.72, 0.72, 1.0);
    vec3 hor = vec3(1.0, 0.83, 0.88);
    vec3 col = mix(hor, mid, smoothstep(0.0, 0.22, h));
    col = mix(col, top, smoothstep(0.22, 0.95, h));
    float s = max(dot(d, uSun), 0.0);
    col += vec3(1.0, 0.8, 0.55) * (pow(s, 900.0) * 3.0 + pow(s, 48.0) * 0.55 + pow(s, 5.0) * 0.16);
    // Wispy painted clouds on a flat layer above the valley.
    if (d.y > 0.02) {
      vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
      float c = fbm(uv * 1.3);
      c = smoothstep(0.52, 0.82, c) * smoothstep(0.02, 0.25, d.y);
      vec3 cloud = mix(vec3(1.0, 0.92, 0.96), vec3(1.0, 0.98, 0.94), s);
      col = mix(col, cloud + vec3(0.12, 0.06, 0.0) * pow(s, 6.0), c * 0.75);
    }
    // Soft pastel haze band at the horizon.
    col = mix(col, vec3(1.0, 0.8, 0.9), (1.0 - smoothstep(-0.05, 0.08, d.y)) * 0.5);
    gl_FragColor = vec4(col, 1.0);
  }`

export function buildScenery(scene: THREE.Scene, track: Track, shadowSize: number): Scenery {
  const rand = rng(20260926)
  const field = new RoadField(track)

  // ── sky & fog ───────────────────────────────────────────────
  scene.fog = new THREE.Fog('#ffd2e4', 170, 600)
  scene.background = new THREE.Color('#ffd2e4')
  const sunVec = new THREE.Vector3(0.45, 0.35, -0.8).normalize()
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSun: { value: sunVec }, uTime: { value: 0 } },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  })
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), skyMat)
  sky.renderOrder = -10
  scene.add(sky)

  // ── lights ──────────────────────────────────────────────────
  const hemi = new THREE.HemisphereLight('#ffeef8', '#8a72b8', 0.62)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight('#ffe6c4', 2.9)
  sun.castShadow = true
  const sc = sun.shadow.camera
  sc.left = sc.bottom = -50
  sc.right = sc.top = 50
  sc.near = 10
  sc.far = 230
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.045
  sun.shadow.radius = 3
  sun.shadow.mapSize.set(shadowSize, shadowSize)
  scene.add(sun, sun.target)
  const sunDir = new THREE.Vector3(0.45, 0.8, -0.55).normalize()
  const rim = new THREE.DirectionalLight('#b9a4ff', 0.7)
  rim.position.set(-0.6, 0.4, 0.8)
  scene.add(rim)

  // ── terrain (smooth, indexed, vertex-coloured + grass detail texture) ──────────────
  const X0 = -270
  const X1 = 210
  const Z0 = -280
  const Z1 = 110
  const cell = 3.2
  const nx = Math.ceil((X1 - X0) / cell)
  const nz = Math.ceil((Z1 - Z0) / cell)
  const heightAt = (x: number, z: number) => {
    let h = fbm(x * 0.012, z * 0.012) * 16 - 4 + fbm(x * 0.05 + 7, z * 0.05) * 2.5
    // Rise toward the valley rim so the circuit sits in a bowl.
    const cx = x + 30
    const cz = z + 80
    const rad = Math.hypot(cx * 0.85, cz)
    h += THREE.MathUtils.smoothstep(rad, 150, 260) * 26
    for (const l of LAKES) {
      const d = Math.hypot(x - l.x, z - l.z)
      h = Math.min(h, THREE.MathUtils.lerp(-3.2, h, THREE.MathUtils.smoothstep(d, l.r * 0.55, l.r * 1.45)))
    }
    const road = field.query(x, z)
    if (road.d < 40) {
      const k = THREE.MathUtils.smoothstep(road.d, 0.5, 14)
      h = THREE.MathUtils.lerp(road.y - 0.45, Math.max(h, road.y - 6), k)
      if (road.d > 0.5) h = Math.max(h, road.y - 0.45 - road.d * 0.6)
    }
    return h
  }
  const vcount = (nx + 1) * (nz + 1)
  const tpos = new Float32Array(vcount * 3)
  const tcol = new Float32Array(vcount * 3)
  const tuv = new Float32Array(vcount * 2)
  const grassA = new THREE.Color('#6fcf85')
  const grassB = new THREE.Color('#a8e47a')
  const grassC = new THREE.Color('#57b98a')
  const pinkish = new THREE.Color('#ffa6cf')
  const sand = new THREE.Color('#ffe4b3')
  const frost = new THREE.Color('#fff6fc')
  const lilac = new THREE.Color('#b9a0ff')
  const lawn = new THREE.Color('#8fe08c')
  const tmpC = new THREE.Color()
  for (let j = 0; j <= nz; j += 1)
    for (let i = 0; i <= nx; i += 1) {
      const k = j * (nx + 1) + i
      const x = X0 + i * cell
      const z = Z0 + j * cell
      const h = heightAt(x, z)
      tpos[k * 3] = x
      tpos[k * 3 + 1] = h
      tpos[k * 3 + 2] = z
      tuv[k * 2] = x / 7
      tuv[k * 2 + 1] = z / 7
      const n = fbm(x * 0.03, z * 0.03)
      const fine = vnoise(x * 0.35, z * 0.35)
      tmpC.copy(grassA).lerp(grassB, THREE.MathUtils.clamp(n * 1.6 - 0.3, 0, 1))
      tmpC.lerp(grassC, THREE.MathUtils.clamp((0.45 - fine) * 0.8, 0, 0.35))
      if (n > 0.72) tmpC.lerp(pinkish, THREE.MathUtils.smoothstep(n, 0.72, 0.8) * 0.6)
      if (n < 0.27) tmpC.lerp(lilac, THREE.MathUtils.smoothstep(0.27 - n, 0, 0.06) * 0.4)
      // Mown lawn stripes near the circuit.
      const road = field.query(x, z, 2)
      if (road.d < 26 && road.d > -2) tmpC.lerp(lawn, (1 - THREE.MathUtils.smoothstep(road.d, 10, 26)) * (Math.sin((x + z) * 0.35) > 0 ? 0.35 : 0.12))
      if (h < -1.2) tmpC.lerp(sand, THREE.MathUtils.smoothstep(-h, 1.2, 2))
      if (h > 16) tmpC.lerp(frost, THREE.MathUtils.clamp((h - 16) / 6, 0, 1))
      tcol[k * 3] = tmpC.r
      tcol[k * 3 + 1] = tmpC.g
      tcol[k * 3 + 2] = tmpC.b
    }
  const tidx: number[] = []
  for (let j = 0; j < nz; j += 1)
    for (let i = 0; i < nx; i += 1) {
      const a = j * (nx + 1) + i
      const b = a + 1
      const c = a + nx + 1
      const d = c + 1
      if ((i + j) % 2 === 0) tidx.push(a, c, b, b, c, d)
      else tidx.push(a, c, d, a, d, b)
    }
  const tgeo = new THREE.BufferGeometry()
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3))
  tgeo.setAttribute('color', new THREE.BufferAttribute(tcol, 3))
  tgeo.setAttribute('uv', new THREE.BufferAttribute(tuv, 2))
  tgeo.setIndex(tidx)
  tgeo.computeVertexNormals()
  const terrain = new THREE.Mesh(tgeo, new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTexture(), roughness: 0.92 }))
  terrain.receiveShadow = true
  scene.add(terrain)
  // Far ring below the rim hides the terrain edge in the fog.
  const ring = new THREE.Mesh(new THREE.RingGeometry(420, 1400, 64), new THREE.MeshBasicMaterial({ color: '#f3c3da' }))
  ring.rotation.x = -Math.PI / 2
  ring.position.set(-30, 18, -80)
  scene.add(ring)

  // ── soda lakes ──────────────────────────────────────────────
  const rippleTex = rippleNormalTexture()
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: '#74d8ff',
    emissive: '#3aa8e0',
    emissiveIntensity: 0.18,
    roughness: 0.06,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.86,
    normalMap: rippleTex,
    normalScale: new THREE.Vector2(0.35, 0.35),
  })
  const waters: THREE.Mesh[] = []
  for (const l of LAKES) {
    const g = new THREE.CircleGeometry(l.r * 1.25, 48)
    const uv = g.getAttribute('uv')
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * l.r * 0.12, uv.getY(i) * l.r * 0.12)
    const w = new THREE.Mesh(g, waterMat)
    w.rotation.x = -Math.PI / 2
    w.position.set(l.x, -1.05, l.z)
    w.receiveShadow = true
    scene.add(w)
    waters.push(w)
  }
  // Lily pads with little blossoms.
  const padGeo = new THREE.CylinderGeometry(1, 1, 0.06, 18, 1, false, 0.35, Math.PI * 2 - 0.7)
  const pads = new THREE.InstancedMesh(padGeo, new THREE.MeshStandardMaterial({ color: '#63c46a', roughness: 0.5 }), 40)
  const blossoms = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.28, 1), new THREE.MeshStandardMaterial({ color: '#ffb3d6', roughness: 0.4, emissive: '#ff7ab6', emissiveIntensity: 0.15 }), 40)
  let padN = 0
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const v = new THREE.Vector3()
  const sv = new THREE.Vector3()
  for (const l of LAKES)
    for (let k = 0; k < Math.round(l.r * 0.6) && padN < 40; k += 1) {
      const a = rand() * Math.PI * 2
      const rr = l.r * (0.2 + rand() * 0.75)
      const s = 0.8 + rand() * 0.9
      m4.compose(v.set(l.x + Math.cos(a) * rr, -0.98, l.z + Math.sin(a) * rr), q.setFromEuler(new THREE.Euler(0, rand() * 6, 0)), sv.set(s, 1, s))
      pads.setMatrixAt(padN, m4)
      m4.compose(v.set(l.x + Math.cos(a) * rr, -0.8, l.z + Math.sin(a) * rr), q.identity(), sv.set(1, 0.7, 1).multiplyScalar(rand() < 0.5 ? 0 : 1))
      blossoms.setMatrixAt(padN, m4)
      padN += 1
    }
  pads.count = blossoms.count = padN
  scene.add(pads, blossoms)

  // ── instanced candy flora ───────────────────────────────────
  const place = (count: number, minRoad: number, maxRoad: number, fn: (x: number, z: number, y: number, i: number) => void) => {
    let n = 0
    let tries = 0
    while (n < count && tries < count * 40) {
      tries += 1
      const x = X0 + 20 + rand() * (X1 - X0 - 40)
      const z = Z0 + 20 + rand() * (Z1 - Z0 - 40)
      const road = field.query(x, z, 4)
      if (road.d < minRoad || road.d > maxRoad) continue
      if (LAKES.some(l => Math.hypot(x - l.x, z - l.z) < l.r * 1.2)) continue
      fn(x, z, heightAt(x, z), n)
      n += 1
    }
    return n
  }
  const pastel = ['#ff6fa8', '#ffb347', '#7fd9ff', '#b58cff', '#ffe066', '#6ff0b0', '#ff8a7a'].map(c => new THREE.Color(c))
  const finish = (...ms: THREE.InstancedMesh[]) => {
    for (const m of ms) {
      m.castShadow = true
      m.receiveShadow = true
      scene.add(m)
    }
  }
  const glossy = (extra: THREE.MeshPhysicalMaterialParameters = {}) => new THREE.MeshPhysicalMaterial({ roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.15, ...extra })

  // Swirl lollipop trees: two interleaved spiral tubes (tinted + white) on a ribboned stick.
  const LOLLI = 70
  const [spiralA, spiralB] = [0, Math.PI].map(spiralGeometry)
  const sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.19, 1, 10), glossy({ color: '#fff7ee' }), LOLLI)
  const candyA = new THREE.InstancedMesh(spiralA, glossy({ color: '#ffffff' }), LOLLI)
  const candyB = new THREE.InstancedMesh(spiralB, glossy({ color: '#fffafc' }), LOLLI)
  const nLolli = place(LOLLI, 3, 90, (x, z, y, i) => {
    const h = 3.2 + rand() * 3
    const r = 1.3 + rand() * 1.1
    m4.compose(v.set(x, y + h / 2, z), q.identity(), sv.set(1, h, 1))
    sticks.setMatrixAt(i, m4)
    q.setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, (rand() - 0.5) * 0.2))
    m4.compose(v.set(x, y + h + r * 0.75, z), q, sv.set(r, r, r))
    candyA.setMatrixAt(i, m4)
    candyB.setMatrixAt(i, m4)
    candyA.setColorAt(i, pastel[i % pastel.length])
  })
  sticks.count = candyA.count = candyB.count = nLolli
  finish(sticks, candyA, candyB)

  // Cotton-candy trees: fluffy clustered puffs on a twisty trunk.
  const FLOSS = 55
  const trunks = new THREE.InstancedMesh(trunkGeometry(), new THREE.MeshStandardMaterial({ color: '#c98a73', roughness: 0.8 }), FLOSS)
  const floss = new THREE.InstancedMesh(flossGeometry(), new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.9, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffffff') }), FLOSS)
  const flossCols = ['#ffb3d9', '#b8d8ff', '#d9c2ff', '#ffd1e8', '#c2f0ff'].map(c => new THREE.Color(c))
  const nFloss = place(FLOSS, 6, 110, (x, z, y, i) => {
    const s = 1.6 + rand() * 1.4
    m4.compose(v.set(x, y - 0.2, z), q.setFromEuler(new THREE.Euler(0, rand() * 6, 0)), sv.set(s, s * (0.9 + rand() * 0.3), s))
    trunks.setMatrixAt(i, m4)
    floss.setMatrixAt(i, m4)
    floss.setColorAt(i, flossCols[i % flossCols.length])
  })
  trunks.count = floss.count = nFloss
  finish(trunks, floss)

  // Gumdrop bushes with a sugary gloss.
  const GUM = 200
  const gum = new THREE.InstancedMesh(gumdropGeometry(), glossy({ roughness: 0.35, clearcoat: 0.6, sheen: 0.6, sheenColor: new THREE.Color('#ffffff') }), GUM)
  gum.count = place(GUM, 1.2, 120, (x, z, y, i) => {
    const s = 0.8 + rand() * 1.6
    m4.compose(v.set(x, y - 0.1, z), q.setFromEuler(new THREE.Euler(0, rand() * 6, 0)), sv.set(s, s * (0.8 + rand() * 0.4), s))
    gum.setMatrixAt(i, m4)
    gum.setColorAt(i, pastel[Math.floor(rand() * pastel.length)])
  })
  finish(gum)

  // Candy canes.
  const CANE = 28
  const cane = new THREE.InstancedMesh(caneGeometry(), glossy({ vertexColors: true }), CANE)
  cane.count = place(CANE, 4, 70, (x, z, y, i) => {
    const s = 1.4 + rand() * 1.4
    m4.compose(v.set(x, y - 0.3, z), q.setFromEuler(new THREE.Euler(0, rand() * 6, 0)), sv.set(s, s, s))
    cane.setMatrixAt(i, m4)
  })
  finish(cane)

  // Candy mushrooms: white stems, tinted glossy caps, white dots.
  const MUSH = 46
  const mush = mushroomGeometries()
  const stems = new THREE.InstancedMesh(mush.stem, new THREE.MeshStandardMaterial({ color: '#fff6ec', roughness: 0.6 }), MUSH)
  const caps = new THREE.InstancedMesh(mush.cap, glossy(), MUSH)
  const dots = new THREE.InstancedMesh(mush.dots, new THREE.MeshStandardMaterial({ color: '#fffaf5', roughness: 0.5 }), MUSH)
  const capCols = ['#ff5f7e', '#ff8fc7', '#b58cff', '#ffb347', '#6fc8ff'].map(c => new THREE.Color(c))
  const nMush = place(MUSH, 2.5, 80, (x, z, y, i) => {
    const s = 0.7 + rand() * 1.3
    m4.compose(v.set(x, y - 0.1, z), q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.25, rand() * 6, (rand() - 0.5) * 0.25)), sv.set(s, s, s))
    stems.setMatrixAt(i, m4)
    caps.setMatrixAt(i, m4)
    dots.setMatrixAt(i, m4)
    caps.setColorAt(i, capCols[i % capCols.length])
  })
  stems.count = caps.count = dots.count = nMush
  finish(stems, caps, dots)

  // Marshmallow rocks (rounded edges).
  const MALLOW = 60
  const mallow = new THREE.InstancedMesh(marshmallowGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.95 }), MALLOW)
  const mallowCols = ['#fff6f2', '#ffd9ea', '#ffe9c7', '#e6dcff'].map(c => new THREE.Color(c))
  mallow.count = place(MALLOW, 1.5, 60, (x, z, y, i) => {
    const s = 0.7 + rand() * 1.2
    m4.compose(v.set(x, y + 0.35 * s, z), q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.4, rand() * 6, (rand() - 0.5) * 0.4)), sv.set(s, s, s))
    mallow.setMatrixAt(i, m4)
    mallow.setColorAt(i, mallowCols[i % mallowCols.length])
  })
  finish(mallow)

  // Meadow flowers and grass tufts close to the road (cheap, but they sell the scale).
  const FLOWERS = 520
  const petals = new THREE.InstancedMesh(flowerGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }), FLOWERS)
  const centres = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 1), new THREE.MeshStandardMaterial({ color: '#ffd23f', roughness: 0.5 }), FLOWERS)
  const flowerCols = ['#ffffff', '#ffd1e8', '#fff3a8', '#d9c2ff', '#ffb3c7', '#bfe8ff'].map(c => new THREE.Color(c))
  const nFlowers = place(FLOWERS, 1.2, 36, (x, z, y, i) => {
    const s = 0.8 + rand() * 0.8
    q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.5, rand() * 6, (rand() - 0.5) * 0.5))
    m4.compose(v.set(x, y + 0.22 * s, z), q, sv.set(s, s, s))
    petals.setMatrixAt(i, m4)
    centres.setMatrixAt(i, m4)
    petals.setColorAt(i, flowerCols[i % flowerCols.length])
  })
  petals.count = centres.count = nFlowers
  scene.add(petals, centres)
  const TUFTS = 1600
  const tufts = new THREE.InstancedMesh(tuftGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), TUFTS)
  const tuftCols = ['#5fc27a', '#7fd67f', '#9ee27a', '#4fb58a'].map(c => new THREE.Color(c))
  tufts.count = place(TUFTS, 0.9, 30, (x, z, y, i) => {
    const s = 0.6 + rand() * 0.9
    m4.compose(v.set(x, y - 0.05, z), q.setFromEuler(new THREE.Euler(0, rand() * 6, 0)), sv.set(s, s * (0.8 + rand() * 0.6), s))
    tufts.setMatrixAt(i, m4)
    tufts.setColorAt(i, tuftCols[i % tuftCols.length])
  })
  scene.add(tufts)

  // Distant cupcake mountains.
  const cupcakes = new THREE.Group()
  const cupCols = ['#ff9ec7', '#b6a1ff', '#9ee7ff', '#ffd27a', '#ffb3a1']
  for (let i = 0; i < 11; i += 1) {
    const a = (i / 11) * Math.PI * 2 + 0.3
    const R = 290 + (i % 3) * 40
    const x = -30 + Math.cos(a) * R * 1.1
    const z = -80 + Math.sin(a) * R * 0.85
    const s = 28 + (i % 4) * 9
    const cup = cupcake(cupCols[i % cupCols.length], s, rand)
    cup.position.set(x, 8 + (i % 2) * 6, z)
    cup.rotation.y = a
    cupcakes.add(cup)
  }
  scene.add(cupcakes)

  // Candy castle on the far rim, between two cupcakes.
  const castle = candyCastle()
  {
    const a = (5.5 / 11) * Math.PI * 2 + 0.3
    castle.position.set(-30 + Math.cos(a) * 330, 22, -80 + Math.sin(a) * 270)
    castle.rotation.y = -a + Math.PI / 2
    castle.scale.setScalar(1.6)
    scene.add(castle)
  }

  // Cotton-candy clouds (smooth puffs).
  const clouds = new THREE.Group()
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#fff5fb', emissive: '#ffdcee', emissiveIntensity: 0.45, roughness: 1, fog: true })
  const puff = new THREE.SphereGeometry(1, 18, 12)
  for (let i = 0; i < 18; i += 1) {
    const c = new THREE.Group()
    const n = 5 + Math.floor(rand() * 5)
    for (let k = 0; k < n; k += 1) {
      const m = new THREE.Mesh(puff, cloudMat)
      const s = 5 + rand() * 7
      const mid = 1 - Math.abs(k - n / 2) / n
      m.scale.set(s * 1.3, s * (0.6 + mid * 0.5), s)
      m.position.set((k - n / 2) * 6.5 + rand() * 3, rand() * 3 + mid * 3, rand() * 5)
      c.add(m)
    }
    c.position.set(-300 + rand() * 560, 70 + rand() * 50, -330 + rand() * 420)
    c.userData.speed = 1 + rand() * 2
    clouds.add(c)
  }
  scene.add(clouds)

  // Hot-air balloons drifting over the valley.
  const balloons: { g: THREE.Group; base: THREE.Vector3; phase: number }[] = []
  const balloonCols: [string, string][] = [['#ff6fa8', '#fff4c8'], ['#7fd9ff', '#ffffff'], ['#b58cff', '#ffe066'], ['#ffb347', '#ff6f7e']]
  balloonCols.forEach(([a, b], i) => {
    const g = hotAirBalloon(a, b)
    const base = new THREE.Vector3(-150 + i * 95 + rand() * 30, 48 + rand() * 30, -210 + rand() * 260)
    g.position.copy(base)
    g.scale.setScalar(2.2 + rand() * 0.8)
    scene.add(g)
    balloons.push({ g, base, phase: rand() * 10 })
  })

  // ── landmarks ───────────────────────────────────────────────
  // Frosted donut arch over the hill crest.
  const donut = new THREE.Group()
  const R = 14
  const dough = new THREE.Mesh(new THREE.TorusGeometry(R, 2.5, 20, 72), new THREE.MeshStandardMaterial({ color: '#e9a15e', roughness: 0.75 }))
  const icing = new THREE.Mesh(new THREE.TorusGeometry(R, 2.75, 20, 72, Math.PI * 1.02), glossy({ color: '#ff7eb6', roughness: 0.18 }))
  icing.position.z = 0.25
  icing.rotation.z = -0.01
  donut.add(dough, icing)
  // Icing drips hanging off the frosting edge.
  const drips = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.42, 1, 4, 10), glossy({ color: '#ff7eb6', roughness: 0.18 }), 26)
  for (let i = 0; i < 26; i += 1) {
    const a = 0.08 + (i / 25) * (Math.PI - 0.16)
    const side = i % 2 ? 1 : -1
    const len = 0.6 + rand() * 1.1
    m4.compose(v.set(Math.cos(a) * (R + 0.2), Math.sin(a) * (R + 0.2), 0.25 + side * 2.55), q.setFromEuler(new THREE.Euler(0, 0, a - Math.PI / 2)), sv.set(1, len, 0.7))
    drips.setMatrixAt(i, m4)
  }
  donut.add(drips)
  const spr = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.11, 0.7, 3, 6), new THREE.MeshStandardMaterial({ roughness: 0.4 }), 120)
  for (let i = 0; i < 120; i += 1) {
    const a = rand() * Math.PI
    const t = (rand() - 0.5) * 2.4
    const rr = R + Math.cos(t) * 2.85
    m4.compose(v.set(Math.cos(a) * rr, Math.sin(a) * rr, 0.25 + Math.sin(t) * 2.85), q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), sv.set(1, 1, 1))
    spr.setMatrixAt(i, m4)
    spr.setColorAt(i, pastel[i % pastel.length])
  }
  donut.add(spr)
  donut.traverse(o => {
    o.castShadow = true
  })
  donut.position.copy(track.landmarks.arch).setY(track.landmarks.arch.y - 1.5)
  donut.rotation.y = track.landmarks.archYaw
  scene.add(donut)

  // Windmill on a knoll beside the circuit (sails spin).
  const findSpot = (s: number, side: number, minD: number, maxD: number) => {
    for (let off = minD; off < maxD; off += 3) {
      const p = track.main.pointAt(s, side * (WALL + off))
      const r = field.query(p.x, p.z, 4)
      if (r.d > minD * 0.8 && !LAKES.some(l => Math.hypot(p.x - l.x, p.z - l.z) < l.r * 1.5)) return p
    }
    return track.main.pointAt(s, side * (WALL + maxD))
  }
  const mill = windmill()
  {
    const p = findSpot(track.length * 0.62, 1, 22, 70)
    mill.root.position.set(p.x, heightAt(p.x, p.z) - 0.4, p.z)
    mill.root.rotation.y = track.main.yawAt(track.length * 0.62) + Math.PI / 2
    mill.root.scale.setScalar(1.3)
    scene.add(mill.root)
  }

  // Start gantry: two candy-cane pillars and a banner with the race lights.
  const gantry = new THREE.Group()
  const s0 = track.main.at(0)
  const pillarGeo = stripedCylinder(0.7, 9.5)
  const pillarMat = glossy({ vertexColors: true })
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(pillarGeo, pillarMat)
    p.position.copy(s0.pos).addScaledVector(s0.right, side * (WALL + 1.1))
    p.position.y += 4.75
    p.castShadow = true
    gantry.add(p)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1.1, 24, 16), glossy({ color: '#ffe066', emissive: '#ffb300', emissiveIntensity: 0.25 }))
    ball.position.copy(p.position).setY(p.position.y + 5.3)
    gantry.add(ball)
    // Balloon bunch tied to the pillar top.
    for (let k = 0; k < 4; k += 1) {
      const bl = new THREE.Mesh(new THREE.SphereGeometry(0.75, 18, 14), glossy({ color: pastel[(k + (side > 0 ? 2 : 0)) % pastel.length], roughness: 0.15 }))
      bl.scale.set(1, 1.18, 1)
      bl.position.copy(ball.position).add(new THREE.Vector3(Math.cos(k * 1.7) * 1.1, 2.2 + k * 0.35, Math.sin(k * 1.7) * 1.1))
      gantry.add(bl)
    }
  }
  const bannerTex = bannerTexture()
  const trim = glossy({ color: '#ff5f8f' })
  const banner = new THREE.Mesh(new THREE.BoxGeometry((WALL + 1.1) * 2, 2.6, 0.6), [trim, trim, trim, trim, new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.5 }), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.5 })])
  banner.position.copy(s0.pos).setY(s0.pos.y + 8.3)
  banner.rotation.y = Math.atan2(s0.tan.x, s0.tan.z)
  banner.castShadow = true
  gantry.add(banner)
  const startLights: THREE.Mesh[] = []
  for (let i = 0; i < 3; i += 1) {
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ color: '#3a2440', toneMapped: false }))
    l.position.copy(banner.position).addScaledVector(s0.right, (i - 1) * 1.6).addScaledVector(s0.tan, -0.32)
    l.position.y -= 2.1
    l.rotation.y = banner.rotation.y + Math.PI
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.3, 24), glossy({ color: '#2b1a2e' }))
    back.position.copy(l.position).addScaledVector(s0.tan, 0.17)
    back.rotation.set(Math.PI / 2, 0, 0)
    back.rotation.y = 0
    back.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), s0.tan.clone().normalize())
    gantry.add(back, l)
    startLights.push(l)
  }
  scene.add(gantry)

  // Bunting and gumball lamp posts along the start straight.
  const posts: THREE.Vector3[][] = [[], []]
  const lampGeo = new THREE.SphereGeometry(0.42, 18, 12)
  const lampMats = pastel.map(c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.9, roughness: 0.2 }))
  const postGeo = stripedCylinder(0.13, 5.2, '#ffffff', '#b58cff', 6)
  const postMat = glossy({ vertexColors: true })
  let li = 0
  for (let s = -84; s <= 60; s += 16) {
    if (Math.abs(s) < 6) continue
    const smp = track.main.at(s)
    for (const [k, side] of [[0, -1], [1, 1]] as const) {
      const p = smp.pos.clone().addScaledVector(smp.right, side * (WALL + 1.9))
      const post = new THREE.Mesh(postGeo, postMat)
      post.position.copy(p).setY(p.y + 2.6)
      post.castShadow = true
      const lamp = new THREE.Mesh(lampGeo, lampMats[li++ % lampMats.length])
      lamp.position.copy(p).setY(p.y + 5.4)
      scene.add(post, lamp)
      posts[k].push(p.clone().setY(p.y + 5.0))
    }
  }
  scene.add(buntingMesh(posts, rand))

  // Bleachers with bouncing critter fans beside the start straight.
  const fanMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })
  const fans: { mesh: THREE.InstancedMesh; base: THREE.Matrix4[]; phase: number[] } = { mesh: new THREE.InstancedMesh(fanGeometry(), fanMat, 60), base: [], phase: [] }
  const bleacher = new THREE.MeshStandardMaterial({ color: '#b98cff', roughness: 0.6 })
  const bleacherTrim = new THREE.MeshStandardMaterial({ color: '#fff0f7', roughness: 0.5 })
  let fanCount = 0
  for (const [sAt, side] of [[-40, 1], [-70, -1], [20, 1]] as const) {
    const smp = track.main.at(sAt)
    const yaw = Math.atan2(smp.tan.x, smp.tan.z)
    for (let row = 0; row < 3; row += 1) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(22, 1, 2.2), bleacher)
      step.position.copy(smp.pos).addScaledVector(smp.right, side * (WALL + 4 + row * 2.2))
      step.scale.y = 1 + row
      step.position.y = smp.pos.y + (1 + row) * 0.5
      step.rotation.y = yaw
      step.castShadow = step.receiveShadow = true
      const edge = new THREE.Mesh(new THREE.BoxGeometry(22.1, 0.14, 2.24), bleacherTrim)
      edge.position.copy(step.position).setY(smp.pos.y + (1 + row) + 0.02)
      edge.rotation.y = yaw
      scene.add(step, edge)
      for (let k = 0; k < 7 && fanCount < 60; k += 1) {
        const p = smp.pos.clone().addScaledVector(smp.right, side * (WALL + 4 + row * 2.2)).addScaledVector(smp.tan, (k - 3) * 3 + (rand() - 0.5))
        p.y = smp.pos.y + (1 + row) + 0.05
        const mm = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 0)), new THREE.Vector3(1, 1, 1))
        fans.base.push(mm)
        fans.phase.push(rand() * 10)
        fans.mesh.setMatrixAt(fanCount, mm)
        fans.mesh.setColorAt(fanCount, pastel[fanCount % pastel.length])
        fanCount += 1
      }
    }
  }
  fans.mesh.count = fanCount
  fans.mesh.castShadow = true
  scene.add(fans.mesh)

  // Shortcut signpost.
  const sign = new THREE.Group()
  const sp = track.short.at(3)
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3.6, 10), new THREE.MeshStandardMaterial({ color: '#fff5ea' }))
  post.position.y = 1.8
  const signGold = glossy({ color: '#ffd84d' })
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.3, 0.2), [signGold, signGold, signGold, signGold, new THREE.MeshStandardMaterial({ map: arrowTexture() }), signGold])
  board.position.y = 3.4
  sign.add(post, board)
  const main0 = track.main.closest(sp.pos)
  sign.position.copy(track.main.pointAt(main0.s - 18, Math.sign(main0.lateral || 1) * (WALL + 1.3)))
  sign.rotation.y = track.main.yawAt(main0.s - 18) + Math.PI
  sign.traverse(o => (o.castShadow = true))
  scene.add(sign)

  const setShadowMap = (size: number) => {
    sun.shadow.mapSize.set(size, size)
    sun.shadow.map?.dispose()
    sun.shadow.map = null as unknown as THREE.WebGLRenderTarget
  }

  const tmp = new THREE.Matrix4()
  return {
    sun,
    startLights,
    setShadowMap,
    bakeEnvironment(gl) {
      const env = new THREE.Scene()
      const skyCopy = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), skyMat)
      env.add(skyCopy)
      const ground = new THREE.Mesh(new THREE.CircleGeometry(88, 32), new THREE.MeshBasicMaterial({ color: '#86c98f' }))
      ground.rotation.x = -Math.PI / 2
      ground.position.y = -6
      env.add(ground)
      const pmrem = new THREE.PMREMGenerator(gl)
      const tex = pmrem.fromScene(env, 0.02, 0.1, 200).texture
      pmrem.dispose()
      skyCopy.geometry.dispose()
      ground.geometry.dispose()
      scene.environment = tex
      scene.environmentIntensity = 0.32
    },
    update(time, dt, focus) {
      skyMat.uniforms.uTime.value = time
      sun.position.copy(focus).addScaledVector(sunDir, 110)
      sun.target.position.copy(focus)
      for (const w of waters) w.position.y = -1.05 + Math.sin(time * 0.8 + w.position.x) * 0.06
      rippleTex.offset.set(time * 0.02, time * 0.013)
      for (const c of clouds.children) {
        c.position.x += c.userData.speed * dt
        if (c.position.x > 280) c.position.x = -320
      }
      for (const b of balloons) {
        b.g.position.set(b.base.x + Math.sin(time * 0.05 + b.phase) * 30, b.base.y + Math.sin(time * 0.4 + b.phase) * 2.5, b.base.z + Math.cos(time * 0.04 + b.phase) * 20)
        b.g.rotation.y = time * 0.05 + b.phase
      }
      mill.sails.rotation.z = time * 0.9
      for (let i = 0; i < fans.base.length; i += 1) {
        const hop = Math.max(0, Math.sin(time * 7 + fans.phase[i])) * 0.35
        tmp.copy(fans.base[i])
        tmp.elements[13] += hop
        fans.mesh.setMatrixAt(i, tmp)
      }
      fans.mesh.instanceMatrix.needsUpdate = true
    },
  }
}

// ─── geometry helpers ───────────────────────────────────────────────

function grassTexture(): THREE.CanvasTexture {
  const size = 256
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#f2f2f2'
  g.fillRect(0, 0, size, size)
  const r = rng(77)
  // Short blades, drawn with wrap-around so the tile is seamless.
  for (let i = 0; i < 2600; i += 1) {
    const x = r() * size
    const y = r() * size
    const l = 3 + r() * 7
    const a = -Math.PI / 2 + (r() - 0.5) * 0.9
    const shade = r()
    g.strokeStyle = shade < 0.5 ? `rgba(150,170,150,${0.25 + r() * 0.3})` : `rgba(255,255,255,${0.35 + r() * 0.4})`
    g.lineWidth = 1 + r() * 1.2
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      g.beginPath()
      g.moveTo(x + ox, y + oy)
      g.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l)
      g.stroke()
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

function rippleNormalTexture(): THREE.CanvasTexture {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const img = g.createImageData(size, size)
  const hgt = (x: number, y: number) => {
    const u = (x / size) * Math.PI * 2
    const w = (y / size) * Math.PI * 2
    return Math.sin(u * 3 + Math.sin(w * 2) * 1.5) * 0.5 + Math.sin(w * 4 + Math.cos(u * 3)) * 0.35 + Math.sin((u + w) * 5) * 0.15
  }
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const dx = hgt(x + 1, y) - hgt(x - 1, y)
      const dy = hgt(x, y + 1) - hgt(x, y - 1)
      const n = new THREE.Vector3(-dx * 2, -dy * 2, 1).normalize()
      const k = (y * size + x) * 4
      img.data[k] = (n.x * 0.5 + 0.5) * 255
      img.data[k + 1] = (n.y * 0.5 + 0.5) * 255
      img.data[k + 2] = (n.z * 0.5 + 0.5) * 255
      img.data[k + 3] = 255
    }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/** One arm of a double-spiral lollipop (unit radius, in the XY plane). */
function spiralGeometry(phase: number): THREE.BufferGeometry {
  const turns = 2.5
  const pts: THREE.Vector3[] = []
  const N = 70
  for (let i = 0; i <= N; i += 1) {
    const t = i / N
    const a = t * turns * Math.PI * 2 + phase
    const r = 0.08 + t * 0.86
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0))
  }
  const curve = new THREE.CatmullRomCurve3(pts)
  const g = new THREE.TubeGeometry(curve, 90, 0.105, 6, false)
  g.scale(1, 1, 1.5)
  return g
}

function trunkGeometry(): THREE.BufferGeometry {
  const p = new Parts(true)
  p.add(new THREE.CylinderGeometry(0.16, 0.26, 2.6, 10), '#ffffff', [0, 1.3, 0], [0, 0, 0.06])
  p.add(new THREE.CylinderGeometry(0.08, 0.12, 1.1, 8), '#ffffff', [0.35, 2.1, 0], [0, 0, -0.8])
  return p.mesh().geometry
}

function flossGeometry(): THREE.BufferGeometry {
  const p = new Parts(true)
  const puffs: [number, number, number, number][] = [
    [0, 3.3, 0, 1.25],
    [0.9, 3.0, 0.3, 0.9],
    [-0.85, 3.05, -0.2, 0.95],
    [0.2, 3.1, -0.9, 0.85],
    [-0.1, 2.95, 0.95, 0.85],
    [0.3, 4.15, 0.1, 0.8],
    [0.95, 2.35, 0.05, 0.55],
  ]
  for (const [x, y, z, r] of puffs) p.add(new THREE.SphereGeometry(r, 16, 12), '#ffffff', [x, y, z])
  return p.mesh().geometry
}

function gumdropGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, 0)]
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12
    pts.push(new THREE.Vector2(Math.max(0.001, Math.cos(t * Math.PI * 0.5) * (1 - t * 0.15)), Math.sin(t * Math.PI * 0.5) * 1.15))
  }
  return new THREE.LatheGeometry(pts, 20)
}

function marshmallowGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, -0.55)]
  const c = 0.22
  for (let i = 0; i <= 4; i += 1) {
    const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2)
    pts.push(new THREE.Vector2(1 - c + Math.cos(a) * c, -0.55 + c + Math.sin(a) * c))
  }
  for (let i = 0; i <= 4; i += 1) {
    const a = (i / 4) * (Math.PI / 2)
    pts.push(new THREE.Vector2(1 - c + Math.cos(a) * c, 0.55 - c + Math.sin(a) * c))
  }
  pts.push(new THREE.Vector2(0.001, 0.55))
  return new THREE.LatheGeometry(pts, 18)
}

function mushroomGeometries(): { stem: THREE.BufferGeometry; cap: THREE.BufferGeometry; dots: THREE.BufferGeometry } {
  const stem = new THREE.LatheGeometry([new THREE.Vector2(0.001, 0), new THREE.Vector2(0.34, 0), new THREE.Vector2(0.3, 0.5), new THREE.Vector2(0.24, 1.1), new THREE.Vector2(0.28, 1.35), new THREE.Vector2(0.001, 1.4)], 14)
  const capPts: THREE.Vector2[] = [new THREE.Vector2(0.001, 1.2)]
  for (let i = 0; i <= 10; i += 1) {
    const t = i / 10
    const a = t * Math.PI * 0.5
    capPts.push(new THREE.Vector2(Math.cos(a) * 1.05 + 0.001, 1.25 + Math.sin(a) * 0.85))
  }
  capPts.reverse()
  const cap = new THREE.LatheGeometry(capPts, 22)
  const d = new Parts(true)
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2
    const el = i === 0 ? 1.45 : 0.55
    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el))
    const p = new THREE.Vector3(dir.x * 1.05, 1.25 + dir.y * 0.85, dir.z * 1.05)
    const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    const e = new THREE.Euler().setFromQuaternion(qq)
    d.add(new THREE.SphereGeometry(0.16, 10, 6), '#ffffff', [p.x, p.y, p.z], [e.x, e.y, e.z], [1, 0.3, 1])
  }
  return { stem, cap, dots: d.mesh().geometry }
}

function flowerGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const petals = 5
  for (let i = 0; i <= petals * 8; i += 1) {
    const a = (i / (petals * 8)) * Math.PI * 2
    const r = 0.16 + 0.2 * Math.pow(Math.abs(Math.sin((a * petals) / 2)), 0.7)
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  const g = new THREE.ShapeGeometry(shape, 1)
  g.rotateX(-Math.PI / 2)
  return g
}

function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + i * 0.4
    const lean = 0.18
    const w = 0.07
    const h = 0.55 + (i % 2) * 0.2
    const cx = Math.cos(a) * 0.08
    const cz = Math.sin(a) * 0.08
    const px = -Math.sin(a) * w
    const pz = Math.cos(a) * w
    pos.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, cx + Math.cos(a) * lean, h, cz + Math.sin(a) * lean)
    col.push(0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 1.15, 1.15, 1.1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

function caneGeometry(): THREE.BufferGeometry {
  const path = new THREE.CurvePath<THREE.Vector3>()
  path.add(new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 3.2, 0)))
  path.add(new THREE.CubicBezierCurve3(new THREE.Vector3(0, 3.2, 0), new THREE.Vector3(0, 4.4, 0), new THREE.Vector3(1.4, 4.4, 0), new THREE.Vector3(1.4, 3.4, 0)))
  const red = new THREE.Color('#ff3f6e')
  const white = new THREE.Color('#fff6f8')
  return faceColors(new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, 90, 0.28, 12, false), (x, y, z) => (Math.sin((y + x) * 4 + Math.atan2(z, x) * 1.5) > 0 ? red : white))
}

function stripedCylinder(r: number, h: number, a = '#ff3f6e', b = '#fff6f8', seg = 16): THREE.BufferGeometry {
  const ca = new THREE.Color(a)
  const cb = new THREE.Color(b)
  return faceColors(new THREE.CylinderGeometry(r, r, h, seg, Math.ceil(h * 5)), (x, y, z) => (Math.sin(y * 2.2 + Math.atan2(z, x)) > 0 ? ca : cb))
}

function cupcake(frosting: string, s: number, rand: () => number): THREE.Group {
  const g = new THREE.Group()
  // Pleated liner.
  const liner = new THREE.CylinderGeometry(s * 0.9, s * 0.7, s * 0.8, 48, 1, true)
  const lp = liner.getAttribute('position')
  for (let i = 0; i < lp.count; i += 1) {
    const x = lp.getX(i)
    const z = lp.getZ(i)
    const a = Math.atan2(z, x)
    const k = 1 + Math.sin(a * 24) * 0.025
    lp.setXYZ(i, x * k, lp.getY(i), z * k)
  }
  liner.computeVertexNormals()
  const linerMesh = new THREE.Mesh(liner, new THREE.MeshStandardMaterial({ color: '#f5b7c9', roughness: 0.7 }))
  linerMesh.position.y = s * 0.4
  const mat = new THREE.MeshPhysicalMaterial({ color: frosting, roughness: 0.45, sheen: 0.8, sheenColor: new THREE.Color('#ffffff') })
  const tiers = [
    [s * 0.95, s * 0.95, 0.55],
    [s * 0.72, s * 1.38, 0.6],
    [s * 0.46, s * 1.74, 0.7],
  ]
  for (const [r, y, sy] of tiers) {
    const t = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 18), mat)
    t.scale.set(1, sy, 1)
    t.position.y = y
    g.add(t)
  }
  const cherry = new THREE.Mesh(new THREE.SphereGeometry(s * 0.2, 20, 14), new THREE.MeshPhysicalMaterial({ color: '#ff3355', roughness: 0.15, clearcoat: 1 }))
  cherry.position.y = s * 2.12
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.02, s * 0.03, s * 0.35, 6), new THREE.MeshStandardMaterial({ color: '#6a8f3a' }))
  stem.position.set(s * 0.05, s * 2.38, 0)
  stem.rotation.z = -0.3
  g.add(linerMesh, cherry, stem)
  // Sprinkles on the frosting.
  const sprinkles = new THREE.InstancedMesh(new THREE.CapsuleGeometry(s * 0.018, s * 0.08, 2, 4), new THREE.MeshStandardMaterial({ roughness: 0.4 }), 40)
  const cols = ['#ffffff', '#ffe066', '#7fd9ff', '#6ff0b0', '#ff6fa8'].map(c => new THREE.Color(c))
  const m4 = new THREE.Matrix4()
  for (let i = 0; i < 40; i += 1) {
    const a = rand() * Math.PI * 2
    const el = 0.2 + rand() * 1.1
    const r = s * 0.95
    m4.compose(new THREE.Vector3(Math.cos(a) * Math.cos(el) * r, s * 0.95 + Math.sin(el) * r * 0.55 + s * 0.02, Math.sin(a) * Math.cos(el) * r), new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), new THREE.Vector3(1, 1, 1))
    sprinkles.setMatrixAt(i, m4)
    sprinkles.setColorAt(i, cols[i % cols.length])
  }
  g.add(sprinkles)
  return g
}

function candyCastle(): THREE.Group {
  const g = new THREE.Group()
  const wall = new THREE.MeshStandardMaterial({ color: '#ffe3f0', roughness: 0.6 })
  const roofs = ['#ff6fa8', '#b58cff', '#7fd9ff', '#ffb347'].map(c => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.25, clearcoat: 1 }))
  const keep = new THREE.Mesh(new THREE.BoxGeometry(16, 12, 10), wall)
  keep.position.y = 6
  g.add(keep)
  const towers: [number, number, number, number][] = [
    [-9, 0, 2.6, 20],
    [9, 0, 2.6, 20],
    [0, -1, 3.4, 26],
    [-4.5, 3, 1.8, 16],
    [4.5, 3, 1.8, 16],
  ]
  towers.forEach(([x, z, r, h], i) => {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, h, 24), wall)
    t.position.set(x, h / 2, z)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(r * 1.35, r * 2.6, 24), roofs[i % roofs.length])
    roof.position.set(x, h + r * 1.3, z)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r * 0.25, 12, 8), roofs[(i + 1) % roofs.length])
    ball.position.set(x, h + r * 2.7, z)
    g.add(t, roof, ball)
  })
  const gate = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.6, 20, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: '#8a5a44' }))
  gate.rotation.set(Math.PI / 2, 0, Math.PI / 2)
  gate.position.set(0, 3, 5.1)
  g.add(gate)
  return g
}

function windmill(): { root: THREE.Group; sails: THREE.Group } {
  const root = new THREE.Group()
  const tower = new THREE.Mesh(
    new THREE.LatheGeometry([new THREE.Vector2(3.2, 0), new THREE.Vector2(2.8, 4), new THREE.Vector2(2.2, 9), new THREE.Vector2(2.0, 11)], 24),
    new THREE.MeshStandardMaterial({ color: '#fff0f6', roughness: 0.6, side: THREE.DoubleSide }),
  )
  const band = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.18, 8, 32), new THREE.MeshStandardMaterial({ color: '#ff8fc7' }))
  band.rotation.x = Math.PI / 2
  band.position.y = 6
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.8, 3.6, 24), new THREE.MeshPhysicalMaterial({ color: '#7fd9ff', roughness: 0.25, clearcoat: 1 }))
  roof.position.y = 12.8
  const door = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 16, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: '#b56b4f' }))
  door.rotation.set(Math.PI / 2, 0, Math.PI / 2)
  door.position.set(0, 1.4, 3.05)
  const win = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), new THREE.MeshStandardMaterial({ color: '#ffe066', emissive: '#ffcc33', emissiveIntensity: 0.6 }))
  win.position.set(0, 7.6, 2.3)
  win.rotation.x = -0.1
  root.add(tower, band, roof, door, win)
  const sails = new THREE.Group()
  sails.position.set(0, 10.5, 2.6)
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), new THREE.MeshStandardMaterial({ color: '#ffe066', roughness: 0.3 }))
  sails.add(hub)
  const sailMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55, side: THREE.DoubleSide })
  const frameMat = new THREE.MeshStandardMaterial({ color: '#c9772e', roughness: 0.6 })
  for (let i = 0; i < 4; i += 1) {
    const arm = new THREE.Group()
    arm.rotation.z = (i / 4) * Math.PI * 2
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 7.5, 0.2), frameMat)
    beam.position.y = 3.9
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(2, 6), sailMat)
    sail.position.set(1.1, 4.3, 0.05)
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 6), new THREE.MeshStandardMaterial({ color: i % 2 ? '#ff8fc7' : '#7fd9ff', side: THREE.DoubleSide }))
    stripe.position.set(1.1, 4.3, 0.07)
    arm.add(beam, sail, stripe)
    sails.add(arm)
  }
  root.add(sails)
  root.traverse(o => (o.castShadow = true))
  return { root, sails }
}

function hotAirBalloon(a: string, b: string): THREE.Group {
  const g = new THREE.Group()
  const pts: THREE.Vector2[] = []
  for (let i = 0; i <= 16; i += 1) {
    const t = i / 16
    const y = -1.3 + t * 3.2
    const r = t < 0.62 ? 0.35 + Math.sin((t / 0.62) * Math.PI * 0.5) * 1.15 : Math.cos(((t - 0.62) / 0.38) * Math.PI * 0.5) * 1.5 + 0.001
    pts.push(new THREE.Vector2(Math.max(0.001, r), y))
  }
  const ca = new THREE.Color(a)
  const cb = new THREE.Color(b)
  const env = faceColors(new THREE.LatheGeometry(pts, 24), (x, _y, z) => (Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 12) % 2 ? ca : cb))
  g.add(new THREE.Mesh(env, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 })))
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.26, 0.4, 12), new THREE.MeshStandardMaterial({ color: '#b5835a', roughness: 0.8 }))
  basket.position.y = -2.1
  g.add(basket)
  for (let i = 0; i < 4; i += 1) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.85, 4), new THREE.MeshStandardMaterial({ color: '#6b4a3a' }))
    rope.position.set(Math.cos(ang) * 0.3, -1.65, Math.sin(ang) * 0.3)
    g.add(rope)
  }
  return g
}

function buntingMesh(rows: THREE.Vector3[][], rand: () => number): THREE.Mesh {
  const pos: number[] = []
  const col: number[] = []
  const cols = ['#ff6fa8', '#ffe066', '#7fd9ff', '#b58cff', '#6ff0b0', '#ffffff'].map(c => new THREE.Color(c))
  let ci = 0
  for (const row of rows)
    for (let i = 0; i + 1 < row.length; i += 1) {
      const a = row[i]
      const b = row[i + 1]
      const n = 9
      for (let k = 0; k < n; k += 1) {
        const t0 = (k + 0.1) / n
        const t1 = (k + 0.9) / n
        const sag = (t: number) => -Math.sin(t * Math.PI) * 1.1
        const p0 = a.clone().lerp(b, t0).setY(a.y + (b.y - a.y) * t0 + sag(t0))
        const p1 = a.clone().lerp(b, t1).setY(a.y + (b.y - a.y) * t1 + sag(t1))
        const mid = p0.clone().lerp(p1, 0.5)
        mid.y -= 0.75 + rand() * 0.1
        pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, mid.x, mid.y, mid.z)
        const c = cols[ci++ % cols.length]
        for (let j = 0; j < 3; j += 1) col.push(c.r, c.g, c.b)
      }
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }))
  m.castShadow = true
  return m
}

function fanGeometry(): THREE.BufferGeometry {
  const p = new Parts(true)
  p.add(new THREE.CapsuleGeometry(0.42, 0.5, 4, 12), '#ffffff', [0, 0.72, 0])
  p.add(new THREE.SphereGeometry(0.3, 12, 8), '#fff4e8', [0, 0.62, 0.22], [0, 0, 0], [1, 1.1, 0.6])
  p.add(new THREE.SphereGeometry(0.17, 10, 8), '#d8d0dc', [0.25, 1.38, 0])
  p.add(new THREE.SphereGeometry(0.17, 10, 8), '#d8d0dc', [-0.25, 1.38, 0])
  p.add(new THREE.SphereGeometry(0.07, 8, 6), '#1a0f1c', [0.14, 1.05, 0.37])
  p.add(new THREE.SphereGeometry(0.07, 8, 6), '#1a0f1c', [-0.14, 1.05, 0.37])
  p.add(new THREE.CapsuleGeometry(0.08, 0.35, 3, 6), '#ffffff', [0.42, 1.2, 0.05], [0, 0, -0.5])
  p.add(new THREE.CapsuleGeometry(0.08, 0.35, 3, 6), '#ffffff', [-0.42, 1.2, 0.05], [0, 0, 0.5])
  return p.mesh().geometry
}

function bannerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 128
  const g = c.getContext('2d')!
  for (let i = 0; i < 32; i += 1) {
    g.fillStyle = i % 2 ? '#ffffff' : '#ff4f86'
    g.fillRect(i * 32, 0, 32, 16)
    g.fillStyle = i % 2 ? '#ff4f86' : '#ffffff'
    g.fillRect(i * 32, 112, 32, 16)
  }
  const grad = g.createLinearGradient(0, 16, 0, 112)
  grad.addColorStop(0, '#ff7aa8')
  grad.addColorStop(1, '#ff4f86')
  g.fillStyle = grad
  g.fillRect(0, 16, 1024, 96)
  g.font = '900 64px Sora, "Noto Sans SC", sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 12
  g.strokeStyle = '#2b1a2e'
  g.lineJoin = 'round'
  g.strokeText('CRITTER KART · 萌兽卡丁车', 512, 66)
  g.fillStyle = '#fff4c8'
  g.fillText('CRITTER KART · 萌兽卡丁车', 512, 66)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function arrowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#ffd84d'
  g.fillRect(0, 0, 256, 128)
  g.strokeStyle = '#2b1a2e'
  g.lineWidth = 10
  g.strokeRect(5, 5, 246, 118)
  g.fillStyle = '#ff4f86'
  g.strokeStyle = '#2b1a2e'
  g.lineWidth = 8
  g.beginPath()
  g.moveTo(40, 50)
  g.lineTo(150, 50)
  g.lineTo(150, 22)
  g.lineTo(215, 64)
  g.lineTo(150, 106)
  g.lineTo(150, 78)
  g.lineTo(40, 78)
  g.closePath()
  g.fill()
  g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
