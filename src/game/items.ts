import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { COLLISION, groups } from '../engine/kart'
import { RAPIER, type Physics } from '../engine/physics'
import { Trail } from '../engine/trail'
import { CONFIG, type ItemKind } from './config'
import type { Fx } from './fx'
import { Parts } from './kartModel'
import type { Racer } from './racer'
import { rollItem } from './rules'
import type { Track } from './track'

/**
 * Items: Candy Crates on the track (break into Rapier-simulated shards), candy coins (small
 * top-speed bonus, knocked loose by hits) and seven original items — Bubble Shield, Pepper Blast,
 * Triple Pepper, Taffy Trap (dropped behind), Homing Bee (chases the racer directly ahead),
 * Gumball Bomb (lobbed forward or backward, blast radius) and Sugar Rush (invulnerable burst that
 * bowls rivals over). Effects are reported through `ItemHooks` so audio/UI stay decoupled.
 */
export type HitKind = 'bee' | 'taffy' | 'bomb' | 'rush'

export type ItemHooks = {
  sfx(name: string, at: THREE.Vector3, gain?: number): void
  hit(victim: Racer, by: Racer | null, kind: HitKind): void
  blocked(victim: Racer): void
  got(racer: Racer): void
  coin(racer: Racer): void
  boom(at: THREE.Vector3): void
}

type Crate = { mesh: THREE.Group; pos: THREE.Vector3; respawn: number; spin: number }
type Shard = { mesh: THREE.Mesh; body: RAPIER.RigidBody; life: number }
type Trap = { mesh: THREE.Group; body: RAPIER.RigidBody; owner: Racer; life: number; armed: number; wobble: number }
type Bee = { mesh: THREE.Group; owner: Racer; target: Racer | null; s: number; lateral: number; pos: THREE.Vector3; life: number; trail: Trail; wing: THREE.Object3D[]; path: 'main' }
type Bomb = { mesh: THREE.Group; body: RAPIER.RigidBody; owner: Racer; fuse: number; armed: number; mat: THREE.MeshPhysicalMaterial; tip: THREE.Object3D }
type Coin = { pos: THREE.Vector3; respawn: number; phase: number; scale: number }

function crateParts(): { ribbon: THREE.BufferGeometry; bow: THREE.BufferGeometry } {
  const r = new Parts(true)
  r.add(new RoundedBoxGeometry(1.58, 1.58, 0.3, 2, 0.08), '#ffffff')
  r.add(new RoundedBoxGeometry(0.3, 1.58, 1.58, 2, 0.08), '#ffffff')
  const b = new Parts(true)
  b.add(new THREE.TorusGeometry(0.3, 0.1, 10, 22), '#ffe066', [0.28, 0.98, 0], [0, Math.PI / 2, 0.55], [1, 1, 0.8])
  b.add(new THREE.TorusGeometry(0.3, 0.1, 10, 22), '#ffe066', [-0.28, 0.98, 0], [0, Math.PI / 2, -0.55], [1, 1, 0.8])
  b.add(new THREE.SphereGeometry(0.16, 14, 10), '#ffd23f', [0, 0.88, 0])
  b.add(new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), '#ffd23f', [0.18, 0.78, 0.2], [0.5, 0, -0.9])
  b.add(new THREE.CapsuleGeometry(0.07, 0.3, 4, 8), '#ffd23f', [-0.18, 0.78, -0.2], [-0.5, 0, 0.9])
  // Paw print on each side face (no text or symbols).
  for (const ry of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const q = new THREE.Euler(0, ry, 0)
    const place = (x: number, y: number, rad: number) => {
      const v = new THREE.Vector3(x, y, 0.8).applyEuler(q)
      b.add(new THREE.CylinderGeometry(rad, rad, 0.04, 16), '#ffffff', [v.x, v.y, v.z], [Math.PI / 2, ry, 0])
    }
    place(0.4, -0.38, 0.16)
    place(0.22, -0.13, 0.065)
    place(0.4, -0.05, 0.065)
    place(0.58, -0.13, 0.065)
  }
  return { ribbon: r.mesh().geometry, bow: b.mesh().geometry }
}

function coinGeometry(): THREE.BufferGeometry {
  const p = new Parts(true)
  p.add(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 28), '#ffffff', [0, 0, 0], [Math.PI / 2, 0, 0])
  p.add(new THREE.TorusGeometry(0.55, 0.07, 8, 32), '#ffffff')
  // Embossed candy star on both faces.
  const star = new THREE.Shape()
  for (let i = 0; i <= 10; i += 1) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2
    const r = i % 2 ? 0.14 : 0.32
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (i === 0) star.moveTo(x, y)
    else star.lineTo(x, y)
  }
  const sg = new THREE.ExtrudeGeometry(star, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 })
  p.add(sg, '#fff2b0', [0, 0, 0.05])
  p.add(sg.clone(), '#fff2b0', [0, 0, -0.05], [0, Math.PI, 0])
  return p.mesh().geometry
}

export class Items {
  readonly crates: Crate[] = []
  readonly traps: Trap[] = []
  readonly bees: Bee[] = []
  readonly bombs: Bomb[] = []
  readonly coins: Coin[] = []
  private readonly shards: Shard[] = []
  private readonly group = new THREE.Group()
  private readonly crateMats: THREE.MeshPhysicalMaterial[] = []
  private readonly shardGeo = new RoundedBoxGeometry(0.55, 0.55, 0.14, 2, 0.05)
  private readonly shardMats = ['#ff7ab6', '#7fe0ff', '#ffe066', '#b58cff'].map(c => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.2, clearcoat: 1, emissive: c, emissiveIntensity: 0.25 }))
  private readonly coinMesh: THREE.InstancedMesh
  private readonly bombGeo: THREE.BufferGeometry
  private time = 0
  private readonly m4 = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()

  constructor(scene: THREE.Scene, private readonly physics: Physics, private readonly track: Track, private readonly fx: Fx, private readonly hooks: ItemHooks) {
    scene.add(this.group)
    const colors = ['#ff7ab6', '#7fd9ff', '#b58cff', '#ffb347']
    const parts = crateParts()
    const bodyGeo = new RoundedBoxGeometry(1.5, 1.5, 1.5, 3, 0.24)
    const ribbonMat = new THREE.MeshPhysicalMaterial({ color: '#fff6d8', roughness: 0.3, clearcoat: 0.8, sheen: 0.6, sheenColor: new THREE.Color('#ffffff') })
    const bowMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.25, clearcoat: 1 })
    track.itemSpots.forEach((spot, i) => {
      const c = colors[i % colors.length]
      const mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.7, iridescenceIOR: 1.4, emissive: c, emissiveIntensity: 0.3, transparent: true, opacity: 0.93 })
      this.crateMats.push(mat)
      const g = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, mat)
      body.castShadow = true
      g.add(body, new THREE.Mesh(parts.ribbon, ribbonMat), new THREE.Mesh(parts.bow, bowMat))
      g.position.copy(spot.pos)
      this.group.add(g)
      this.crates.push({ mesh: g, pos: spot.pos.clone(), respawn: 0, spin: i * 0.7 })
    })
    // Candy coins in short rows around the lap plus a reward line through the shortcut.
    const L = track.length
    const rows = [0.06, 0.15, 0.24, 0.33, 0.45, 0.56, 0.67, 0.78, 0.9]
    const lanes = [-3.5, 0, 3.5, -1.8, 1.8, -4.5, 4.5, 0, -2.5]
    rows.forEach((f, ri) => {
      let s = f * L
      for (let tries = 0; tries < 6 && track.itemSpots.some(sp => sp.pos.distanceTo(track.main.pointAt(s, 0)) < 12); tries += 1) s += 9
      for (let k = 0; k < 4; k += 1) {
        const p = track.main.pointAt(s + k * 3.4, lanes[ri % lanes.length])
        p.y += 1.05
        this.coins.push({ pos: p, respawn: 0, phase: ri * 0.9 + k * 0.45, scale: 1 })
      }
    })
    for (let k = 0; k < 5; k += 1) {
      const p = track.short.pointAt(track.short.length * 0.28 + k * 3.6, 0)
      p.y += 1.05
      this.coins.push({ pos: p, respawn: 0, phase: k * 0.4, scale: 1 })
    }
    const coinMat = new THREE.MeshPhysicalMaterial({ color: '#ffc93c', metalness: 0.35, roughness: 0.22, clearcoat: 1, emissive: '#ff9f1a', emissiveIntensity: 0.35, vertexColors: true })
    this.coinMesh = new THREE.InstancedMesh(coinGeometry(), coinMat, this.coins.length)
    this.coinMesh.castShadow = true
    this.coinMesh.frustumCulled = false
    this.group.add(this.coinMesh)
    // Gumball bomb (shared geometry; material per bomb so each can blink).
    const bp = new Parts(true)
    bp.add(new THREE.SphereGeometry(0.72, 28, 20), '#ffffff')
    for (let i = 0; i < 14; i += 1) {
      const a = i * 2.39996
      const y = 1 - (i + 0.5) / 7
      const rr = Math.sqrt(Math.max(0, 1 - y * y))
      const dir = new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr)
      const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      const eu = new THREE.Euler().setFromQuaternion(qq)
      bp.add(new THREE.SphereGeometry(0.15, 12, 8), '#fff4fb', [dir.x * 0.71, dir.y * 0.71, dir.z * 0.71], [eu.x, eu.y, eu.z], [1, 0.25, 1])
    }
    bp.add(new THREE.CylinderGeometry(0.2, 0.24, 0.16, 16), '#3a2440', [0, 0.72, 0])
    this.bombGeo = bp.mesh().geometry
  }

  reset(): void {
    for (const c of this.crates) {
      c.respawn = 0
      c.mesh.visible = true
      c.mesh.scale.setScalar(1)
    }
    for (const t of this.traps) this.removeTrap(t)
    this.traps.length = 0
    for (const b of this.bees) this.group.remove(b.mesh, b.trail.mesh)
    this.bees.length = 0
    for (const b of this.bombs) this.removeBomb(b)
    this.bombs.length = 0
    for (const s of this.shards) this.removeShard(s)
    this.shards.length = 0
    for (const c of this.coins) {
      c.respawn = 0
      c.scale = 1
    }
  }

  /** Fixed-step simulation of crates, coins, traps, bees, bombs and shards. */
  step(dt: number, racers: Racer[], ordered: Racer[]): void {
    this.time += dt
    // Crates.
    for (const c of this.crates) {
      if (c.respawn > 0) {
        c.respawn -= dt
        if (c.respawn <= 0) {
          c.mesh.visible = true
          c.mesh.scale.setScalar(0.01)
        }
        continue
      }
      for (const r of racers) {
        if (r.respawnTime > 0) continue
        const d = r.position.distanceToSquared(c.pos)
        if (d < 2.3 * 2.3) {
          this.breakCrate(c, r)
          if (!r.item && r.roulette <= 0) {
            r.roulette = CONFIG.items.roulette
            r.rouletteItem = rollItem(r.place - 1, racers.length, Math.random)
            this.hooks.got(r)
          }
          break
        }
      }
    }
    // Coins.
    const pick = CONFIG.coins.pickup * CONFIG.coins.pickup
    for (const c of this.coins) {
      if (c.respawn > 0) {
        c.respawn -= dt
        continue
      }
      for (const r of racers) {
        if (r.respawnTime > 0) continue
        const dx = r.position.x - c.pos.x
        const dz = r.position.z - c.pos.z
        if (dx * dx + dz * dz < pick && Math.abs(r.position.y - c.pos.y) < 2.2) {
          c.respawn = CONFIG.coins.respawn
          c.scale = 0
          if (r.coins < CONFIG.coins.max) r.coins += 1
          r.coinsCollected += 1
          this.coinBurst(c.pos, 8)
          this.hooks.coin(r)
          break
        }
      }
    }
    // Roulettes and timers.
    for (const r of racers) {
      if (r.roulette > 0) {
        r.roulette -= dt
        if (r.roulette <= 0) {
          r.item = r.rouletteItem
          r.itemCount = r.item === 'triple' ? CONFIG.items.tripleCount : 1
          r.rouletteItem = null
          r.aiItemDelay = 0.6 + Math.random() * 2.2
        }
      }
      r.shieldTime = Math.max(0, r.shieldTime - dt)
      r.goo = Math.max(0, r.goo - dt)
      r.incomingBee = 0
      if (r.rushTime > 0) {
        r.rushTime = Math.max(0, r.rushTime - dt)
        // Keep the boost alive for the whole rush (hits and pads cannot cancel it).
        if (r.kart.boostTime < 0.25) r.kart.boost(0.3, CONFIG.items.rushPower)
        r.kart.stickTime = 0
        r.goo = 0
      }
    }
    // Sugar Rush bowls over anyone it touches.
    for (const a of racers) {
      if (a.rushTime <= 0) continue
      for (const b of racers) {
        if (b === a || b.rushTime > 0 || b.respawnTime > 0 || b.kart.spinTime > 0) continue
        if (a.position.distanceToSquared(b.position) > 2.1 * 2.1) continue
        if (b.shielded) {
          b.shieldTime = 0
          this.fx.bubblePop(b.position)
          this.hooks.blocked(b)
          continue
        }
        const dir = b.position.clone().sub(a.position).setY(0).normalize()
        b.kart.impulse(dir.multiplyScalar(11).add(new THREE.Vector3(0, 6, 0)))
        b.kart.spinOut(0.9, 0.45)
        b.bounce(1.4)
        this.fx.ring(b.position, '#ffe066', 14, 7)
        this.hooks.sfx('bump', b.position)
        this.hooks.hit(b, a, 'rush')
      }
    }
    // Traps.
    for (let i = this.traps.length - 1; i >= 0; i -= 1) {
      const t = this.traps[i]
      t.life -= dt
      t.armed -= dt
      t.wobble = Math.max(0, t.wobble - dt)
      const tp = t.body.translation()
      if (t.life <= 0 || tp.y < -30) {
        this.removeTrap(t)
        this.traps.splice(i, 1)
        continue
      }
      for (const r of racers) {
        if (r.respawnTime > 0 || (r === t.owner && t.armed > 0)) continue
        const dx = r.position.x - tp.x
        const dy = r.position.y - tp.y
        const dz = r.position.z - tp.z
        if (dx * dx + dz * dz < 1.75 * 1.75 && Math.abs(dy) < 2) {
          const at = new THREE.Vector3(tp.x, tp.y, tp.z)
          this.fx.goo(at)
          this.hooks.sfx('taffyHit', at)
          if (r.rushTime > 0) {
            this.fx.ring(at, '#ffe066', 10, 6)
          } else if (r.shielded) {
            r.shieldTime = 0
            this.fx.bubblePop(r.position)
            this.hooks.blocked(r)
          } else {
            r.kart.stick(CONFIG.items.trapStick)
            r.kart.spinOut(0.55, 0.6)
            r.goo = CONFIG.items.trapStick
            r.kart.impulse(new THREE.Vector3(0, 5.5, 0))
            r.bounce(1.2)
            this.hooks.hit(r, t.owner === r ? null : t.owner, 'taffy')
          }
          this.removeTrap(t)
          this.traps.splice(i, 1)
          break
        }
      }
    }
    // Bees.
    for (let i = this.bees.length - 1; i >= 0; i -= 1) {
      const b = this.bees[i]
      b.life -= dt
      if (b.target && b.target.finished) b.target = null
      let hit = false
      if (b.life <= 0) {
        this.fx.ring(b.pos, '#ffe066', 10, 4)
        this.removeBee(b)
        this.bees.splice(i, 1)
        continue
      }
      const target = b.target
      const speed = CONFIG.items.beeSpeed
      if (target) target.incomingBee = Math.max(target.incomingBee, 1)
      const dist = target ? b.pos.distanceTo(target.position) : Infinity
      if (target && dist < CONFIG.items.beeHoming) {
        // Final dive straight at the target.
        const dir = target.position.clone().add(new THREE.Vector3(0, 0.6, 0)).sub(b.pos)
        const len = dir.length()
        b.pos.addScaledVector(dir.normalize(), Math.min(len, speed * 1.1 * dt))
        b.s = target.tracker.loc.path === 'main' ? target.tracker.loc.s : b.s
        if (len < 1.8) hit = true
      } else {
        // Follow the racing line toward the target's lateral position.
        b.s = this.track.main.wrap(b.s + speed * dt)
        const lat = target ? (target.tracker.loc.path === 'main' ? target.tracker.loc.lateral : 0) : 0
        b.lateral += (lat - b.lateral) * (1 - Math.exp(-2 * dt))
        const p = this.track.main.pointAt(b.s, b.lateral)
        p.y += 1.6 + Math.sin(this.time * 9 + i) * 0.3
        b.pos.lerp(p, 1 - Math.exp(-12 * dt))
      }
      if (hit && target) {
        this.fx.pollen(target.position)
        this.hooks.sfx('beeHit', target.position)
        if (target.rushTime > 0) {
          this.fx.ring(target.position, '#ffe066', 12, 6)
        } else if (target.shielded) {
          target.shieldTime = 0
          this.fx.bubblePop(target.position)
          this.hooks.blocked(target)
        } else {
          target.kart.spinOut(CONFIG.items.beeSpin, 0.3)
          const side = new THREE.Vector3((Math.random() - 0.5) * 6, 7.5, (Math.random() - 0.5) * 6)
          target.kart.impulse(side)
          target.bounce(1.6)
          this.hooks.hit(target, b.owner, 'bee')
        }
        this.removeBee(b)
        this.bees.splice(i, 1)
      }
    }
    // Gumball bombs: fuse runs down; contact with a rival detonates early.
    for (let i = this.bombs.length - 1; i >= 0; i -= 1) {
      const b = this.bombs[i]
      b.fuse -= dt
      b.armed -= dt
      const t = b.body.translation()
      const at = new THREE.Vector3(t.x, t.y, t.z)
      let blow = b.fuse <= 0 || t.y < -30
      if (!blow)
        for (const r of racers) {
          if (r.respawnTime > 0 || (r === b.owner && b.armed > 0)) continue
          if (r.position.distanceToSquared(at) < 2.2 * 2.2) {
            blow = true
            break
          }
        }
      if (blow) {
        this.explode(b, at, racers)
        this.removeBomb(b)
        this.bombs.splice(i, 1)
      }
    }
    // Shards.
    for (let i = this.shards.length - 1; i >= 0; i -= 1) {
      const s = this.shards[i]
      s.life -= dt
      if (s.life <= 0) {
        this.removeShard(s)
        this.shards.splice(i, 1)
      }
    }
    void ordered
  }

  /** Render-rate animation (spinning crates and coins, wings, shard sync, bomb fuses). */
  animate(dt: number, time: number): void {
    for (const c of this.crates) {
      if (!c.mesh.visible) continue
      c.mesh.rotation.y = time * 1.4 + c.spin
      c.mesh.rotation.x = Math.sin(time * 1.3 + c.spin) * 0.18
      c.mesh.position.y = c.pos.y + Math.sin(time * 2.2 + c.spin) * 0.22
      const s = c.mesh.scale.x
      if (s < 1) c.mesh.scale.setScalar(Math.min(1, s + dt * 4 * (1.2 - s)))
    }
    this.crateMats.forEach((m, i) => (m.emissiveIntensity = 0.24 + Math.sin(time * 4 + i) * 0.1))
    this.coins.forEach((c, i) => {
      const target = c.respawn > 0 ? 0 : 1
      c.scale += (target - c.scale) * Math.min(1, dt * (target ? 5 : 30))
      const s = Math.max(0.0001, c.scale)
      this.e.set(0, time * 2.6 + c.phase, 0)
      this.m4.compose(new THREE.Vector3(c.pos.x, c.pos.y + Math.sin(time * 3 + c.phase) * 0.15, c.pos.z), this.q.setFromEuler(this.e), new THREE.Vector3(s, s, s))
      this.coinMesh.setMatrixAt(i, this.m4)
    })
    this.coinMesh.instanceMatrix.needsUpdate = true
    for (const s of this.shards) {
      const t = s.body.translation()
      const r = s.body.rotation()
      s.mesh.position.set(t.x, t.y, t.z)
      s.mesh.quaternion.set(r.x, r.y, r.z, r.w)
      if (s.life < 0.5) s.mesh.scale.setScalar(Math.max(0.01, s.life / 0.5))
    }
    for (const t of this.traps) {
      const p = t.body.translation()
      const r = t.body.rotation()
      t.mesh.position.set(p.x, p.y - 0.25, p.z)
      t.mesh.quaternion.set(r.x, r.y, r.z, r.w)
      const w = 1 + Math.sin(time * 5 + p.x) * 0.05
      t.mesh.scale.set(w, 1 / w, w)
    }
    for (const b of this.bees) {
      b.mesh.position.copy(b.pos)
      const ahead = b.target ? b.target.position : this.track.main.pointAt(b.s + 5)
      b.mesh.lookAt(ahead.x, b.pos.y, ahead.z)
      for (const [k, w] of b.wing.entries()) w.rotation.z = (k ? -1 : 1) * (0.5 + Math.sin(time * 70) * 0.5)
      b.trail.update(b.pos, new THREE.Vector3(0, 1, 0), true)
      if (Math.random() < 0.5) this.fx.glow.spawn({ pos: b.pos, vel: new THREE.Vector3((Math.random() - 0.5) * 2, 0.5, (Math.random() - 0.5) * 2), life: 0.35, size: 0.18, endSize: 0, color: new THREE.Color('#ffe066'), drag: 2 })
    }
    for (const b of this.bombs) {
      const t = b.body.translation()
      const r = b.body.rotation()
      b.mesh.position.set(t.x, t.y, t.z)
      b.mesh.quaternion.set(r.x, r.y, r.z, r.w)
      const rate = b.fuse < 0.6 ? 26 : 10
      const on = Math.sin(time * rate) > 0
      b.mat.emissiveIntensity = on ? 0.9 : 0.15
      const s = 1 + (on ? 0.06 : 0) * (b.fuse < 0.6 ? 2 : 1)
      b.mesh.scale.setScalar(s)
      const tip = b.tip.getWorldPosition(new THREE.Vector3())
      this.fx.glow.spawn({ pos: tip, vel: new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3), life: 0.25, size: 0.2, endSize: 0, color: new THREE.Color(Math.random() < 0.5 ? '#ffe066' : '#ff7b3d'), drag: 3 })
    }
  }

  // ─── item use ────────────────────────────────────────────────────

  /** Use the held item. `back` lobs a Gumball Bomb behind instead of ahead. */
  use(r: Racer, ordered: Racer[], opts: { back?: boolean } = {}): ItemKind | null {
    const kind = r.item
    if (!kind) return null
    r.itemCount = Math.max(0, r.itemCount - 1)
    if (kind !== 'triple' || r.itemCount <= 0) {
      r.item = null
      r.itemCount = 0
    }
    const k = r.kart
    const fwd = k.forward.clone()
    switch (kind) {
      case 'shield':
        r.shieldTime = CONFIG.items.shieldSeconds
        this.fx.ring(r.position, '#9ff4ff', 18, 6, 1)
        this.hooks.sfx('shieldUp', r.position)
        break
      case 'pepper':
      case 'triple':
        k.boost(CONFIG.items.pepperSeconds, CONFIG.items.pepperPower)
        k.cancelDrift()
        this.fx.ring(r.position.clone().addScaledVector(fwd, -1.5), '#ff5a36', 16, 7, 0.5)
        this.hooks.sfx('pepper', r.position)
        break
      case 'taffy':
        this.dropTrap(r)
        this.hooks.sfx('taffyDrop', r.position)
        break
      case 'bee': {
        const idx = ordered.indexOf(r)
        const target = idx > 0 ? ordered[idx - 1] : null
        this.launchBee(r, target)
        this.hooks.sfx('beeLaunch', r.position)
        break
      }
      case 'bomb':
        this.throwBomb(r, !!opts.back)
        this.hooks.sfx('bombThrow', r.position)
        break
      case 'rush':
        r.rushTime = CONFIG.items.rushSeconds
        r.shieldTime = 0
        k.boost(CONFIG.items.rushSeconds, CONFIG.items.rushPower)
        k.stickTime = 0
        this.fx.ring(r.position, '#ffe066', 22, 8, 1)
        this.fx.confetti(r.position.clone().setY(r.position.y + 1.5), 30, 1)
        this.hooks.sfx('rush', r.position)
        break
    }
    return kind
  }

  /** Bee that is chasing `r`, if any (for UI warnings / AI shield timing). */
  beeFor(r: Racer): Bee | undefined {
    return this.bees.find(b => b.target === r)
  }

  obstacles(): { position: THREE.Vector3; radius: number; hazard: boolean }[] {
    const out = this.traps.map(t => {
      const p = t.body.translation()
      return { position: new THREE.Vector3(p.x, p.y, p.z), radius: 1.3, hazard: true }
    })
    for (const b of this.bombs) {
      const p = b.body.translation()
      out.push({ position: new THREE.Vector3(p.x, p.y, p.z), radius: 3, hazard: true })
    }
    return out
  }

  /** Knock `n` coins loose from a hit racer (sparkly burst, coins are lost). */
  spill(r: Racer, n: number): number {
    const lost = Math.min(r.coins, n)
    if (lost <= 0) return 0
    r.coins -= lost
    this.coinBurst(r.position.clone().setY(r.position.y + 1), 6 * lost)
    return lost
  }

  private coinBurst(at: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i += 1)
      this.fx.glow.spawn({ pos: at, vel: new THREE.Vector3((Math.random() - 0.5) * 7, 3 + Math.random() * 5, (Math.random() - 0.5) * 7), life: 0.45 + Math.random() * 0.25, size: 0.22, endSize: 0, color: new THREE.Color(i % 3 ? '#ffd23f' : '#fff4c8'), drag: 2.5 })
  }

  private explode(b: Bomb, at: THREE.Vector3, racers: Racer[]): void {
    const R = CONFIG.items.bombRadius
    this.fx.ring(at, '#ff6fa8', R * 2.4, 10, 1)
    this.fx.ring(at, '#ffe066', R * 1.6, 8, 0.7)
    this.fx.confetti(at.clone().setY(at.y + 1), 50, 1.3)
    for (let i = 0; i < 26; i += 1)
      this.fx.glow.spawn({ pos: at, vel: new THREE.Vector3((Math.random() - 0.5) * 22, Math.random() * 14, (Math.random() - 0.5) * 22), life: 0.5 + Math.random() * 0.3, size: 0.5, endSize: 0, color: new THREE.Color(['#ff6fa8', '#ffe066', '#ffffff', '#7fd9ff'][i % 4]), drag: 3 })
    this.hooks.sfx('boom', at, 1.2)
    this.hooks.boom(at)
    for (const r of racers) {
      if (r.respawnTime > 0) continue
      const d = r.position.distanceTo(at)
      if (d > R || Math.abs(r.position.y - at.y) > 4) continue
      if (r.rushTime > 0) continue
      if (r.shielded) {
        r.shieldTime = 0
        this.fx.bubblePop(r.position)
        this.hooks.blocked(r)
        continue
      }
      const dir = r.position.clone().sub(at).setY(0)
      if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5)
      dir.normalize()
      r.kart.spinOut(CONFIG.items.bombSpin, 0.25)
      r.kart.impulse(dir.multiplyScalar(6 * (1 - d / R) + 2).add(new THREE.Vector3(0, 10, 0)))
      r.bounce(2)
      this.hooks.hit(r, r === b.owner ? null : b.owner, 'bomb')
    }
  }

  private breakCrate(c: Crate, r: Racer): void {
    c.mesh.visible = false
    c.respawn = CONFIG.items.boxRespawn
    this.fx.confetti(c.pos, 22, 0.9)
    this.fx.ring(c.pos, '#ffffff', 12, 7, 0.5)
    this.hooks.sfx('crate', c.pos)
    const vel = r.kart.velocity
    for (let i = 0; i < 7; i += 1) {
      const mesh = new THREE.Mesh(this.shardGeo, this.shardMats[i % this.shardMats.length])
      mesh.position.copy(c.pos).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2))
      mesh.castShadow = true
      this.group.add(mesh)
      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
          .setLinvel(vel.x * 0.7 + (Math.random() - 0.5) * 9, 4 + Math.random() * 6, vel.z * 0.7 + (Math.random() - 0.5) * 9)
          .setAngvel({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 })
          .setLinearDamping(0.3),
      )
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.27, 0.27, 0.07).setRestitution(0.45).setFriction(0.6).setDensity(0.6).setCollisionGroups(groups(COLLISION.DEBRIS, COLLISION.GROUND | COLLISION.WALL)),
        body,
      )
      this.shards.push({ mesh, body, life: 1.8 + Math.random() * 0.6 })
    }
  }

  private dropTrap(r: Racer): void {
    const k = r.kart
    const fwd = k.forward
    const at = k.position.clone().addScaledVector(fwd, -2.6)
    at.y += 0.5
    const g = new THREE.Group()
    const p = new Parts(true)
    p.add(new THREE.SphereGeometry(1, 24, 14), '#7ef0c0', [0, 0.35, 0], [0, 0, 0], [1.25, 0.5, 1.25])
    p.add(new THREE.SphereGeometry(0.6, 20, 12), '#ff9ec4', [0.25, 0.62, 0.1], [0, 0, 0], [1, 0.6, 1])
    p.add(new THREE.SphereGeometry(0.35, 16, 10), '#fff6fb', [-0.3, 0.75, -0.2])
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2
      p.add(new THREE.SphereGeometry(0.28, 14, 8), i % 2 ? '#7ef0c0' : '#ff9ec4', [Math.cos(a) * 1.2, 0.12, Math.sin(a) * 1.2], [0, 0, 0], [1.2, 0.4, 1.2])
    }
    const mesh = p.mesh(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, emissive: '#3a1030', emissiveIntensity: 0.12, transparent: true, opacity: 0.94 }))
    g.add(mesh)
    this.group.add(g)
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setLinvel(k.velocity.x * 0.25 - fwd.x * 2, 2.5, k.velocity.z * 0.25 - fwd.z * 2)
        .setLinearDamping(1.8)
        .setAngularDamping(4)
        .enabledRotations(false, true, false),
    )
    this.physics.world.createCollider(RAPIER.ColliderDesc.ball(0.5).setRestitution(0.2).setFriction(1).setCollisionGroups(groups(COLLISION.DEBRIS, COLLISION.GROUND | COLLISION.WALL)), body)
    this.traps.push({ mesh: g, body, owner: r, life: CONFIG.items.trapLife, armed: 0.8, wobble: 0 })
    if (this.traps.length > CONFIG.items.maxTraps) {
      const old = this.traps.shift()!
      this.removeTrap(old)
    }
  }

  private throwBomb(r: Racer, back: boolean): void {
    const k = r.kart
    const fwd = k.forward.clone()
    const at = k.position.clone().addScaledVector(fwd, back ? -2.4 : 2.2)
    at.y += 1.2
    const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, color: '#ff5fa2', roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.04, emissive: '#ff2f7a', emissiveIntensity: 0.2 })
    const g = new THREE.Group()
    const ball = new THREE.Mesh(this.bombGeo, mat)
    ball.castShadow = true
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.34, 6), new THREE.MeshStandardMaterial({ color: '#f5e6c8' }))
    fuse.position.set(0.05, 0.92, 0)
    fuse.rotation.z = -0.35
    const tip = new THREE.Object3D()
    tip.position.set(0.12, 1.08, 0)
    g.add(ball, fuse, tip)
    g.position.copy(at)
    this.group.add(g)
    const v = k.velocity
    const lin = back ? { x: v.x * 0.3 - fwd.x * 7, y: 6, z: v.z * 0.3 - fwd.z * 7 } : { x: v.x + fwd.x * 15, y: 8, z: v.z + fwd.z * 15 }
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setLinvel(lin.x, lin.y, lin.z)
        .setAngvel({ x: (Math.random() - 0.5) * 6, y: 0, z: (Math.random() - 0.5) * 6 })
        .setLinearDamping(0.5)
        .setAngularDamping(1.5),
    )
    this.physics.world.createCollider(RAPIER.ColliderDesc.ball(0.7).setRestitution(0.35).setFriction(0.9).setDensity(1.4).setCollisionGroups(groups(COLLISION.DEBRIS, COLLISION.GROUND | COLLISION.WALL)), body)
    this.bombs.push({ mesh: g, body, owner: r, fuse: CONFIG.items.bombFuse, armed: 0.5, mat, tip })
  }

  private launchBee(r: Racer, target: Racer | null): void {
    const g = new THREE.Group()
    const p = new Parts(true)
    p.add(new THREE.SphereGeometry(0.42, 20, 14), '#ffd23f', [0, 0, 0], [0, 0, 0], [0.9, 0.9, 1.25])
    p.add(new THREE.CylinderGeometry(0.4, 0.4, 0.14, 20), '#2b1a2e', [0, 0, -0.08], [Math.PI / 2, 0, 0])
    p.add(new THREE.CylinderGeometry(0.33, 0.33, 0.12, 20), '#2b1a2e', [0, 0, -0.34], [Math.PI / 2, 0, 0])
    p.add(new THREE.SphereGeometry(0.3, 18, 12), '#2b1a2e', [0, 0.05, 0.5])
    p.add(new THREE.SphereGeometry(0.09, 10, 8), '#ffffff', [0.12, 0.12, 0.74])
    p.add(new THREE.SphereGeometry(0.09, 10, 8), '#ffffff', [-0.12, 0.12, 0.74])
    p.add(new THREE.SphereGeometry(0.045, 8, 6), '#1a0f1c', [0.12, 0.13, 0.82])
    p.add(new THREE.SphereGeometry(0.045, 8, 6), '#1a0f1c', [-0.12, 0.13, 0.82])
    p.add(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4), '#2b1a2e', [0.1, 0.36, 0.62], [0.5, 0, -0.3])
    p.add(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4), '#2b1a2e', [-0.1, 0.36, 0.62], [0.5, 0, 0.3])
    p.add(new THREE.ConeGeometry(0.08, 0.25, 8), '#2b1a2e', [0, 0, -0.62], [-Math.PI / 2, 0, 0])
    g.add(p.mesh(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.6 })))
    const wingMat = new THREE.MeshBasicMaterial({ color: '#e8fbff', transparent: true, opacity: 0.75, side: THREE.DoubleSide })
    const wing: THREE.Object3D[] = []
    for (const s of [1, -1]) {
      const pivot = new THREE.Group()
      pivot.position.set(s * 0.15, 0.32, 0)
      const w = new THREE.Mesh(new THREE.CircleGeometry(0.34, 16), wingMat)
      w.position.set(s * 0.3, 0.05, 0)
      w.rotation.x = -Math.PI / 2
      w.scale.set(1, 0.6, 1)
      pivot.add(w)
      g.add(pivot)
      wing.push(pivot)
    }
    g.scale.setScalar(1.35)
    const pos = r.position.clone().add(new THREE.Vector3(0, 1.6, 0))
    g.position.copy(pos)
    const trail = new Trail(18, 0.3, '#ffe066', 0.7)
    this.group.add(g, trail.mesh)
    const loc = r.tracker.loc
    this.bees.push({ mesh: g, owner: r, target, s: loc.mainS, lateral: loc.path === 'main' ? loc.lateral : 0, pos, life: CONFIG.items.beeLife, trail, wing, path: 'main' })
  }

  private removeTrap(t: Trap): void {
    this.group.remove(t.mesh)
    ;(t.mesh.children[0] as THREE.Mesh).geometry.dispose()
    if (this.physics.world.getRigidBody(t.body.handle)) this.physics.world.removeRigidBody(t.body)
  }

  private removeBomb(b: Bomb): void {
    this.group.remove(b.mesh)
    b.mat.dispose()
    if (this.physics.world.getRigidBody(b.body.handle)) this.physics.world.removeRigidBody(b.body)
  }

  private removeBee(b: Bee): void {
    this.group.remove(b.mesh, b.trail.mesh)
  }

  private removeShard(s: Shard): void {
    this.group.remove(s.mesh)
    if (this.physics.world.getRigidBody(s.body.handle)) this.physics.world.removeRigidBody(s.body)
  }
}
