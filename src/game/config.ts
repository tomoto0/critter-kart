import type { KartSpec } from '../engine/kart'

/**
 * All gameplay tuning in one place. Change numbers here before touching game code; tests read
 * the same values so rule changes stay covered.
 */
export const BASE_KART: KartSpec = {
  radius: 0.62,
  rideHeight: 0.62,
  mass: 1,
  maxSpeed: 25,
  accel: 17,
  reverseSpeed: 8,
  brakeDecel: 32,
  coastDecel: 5,
  turnRate: 2.05,
  grip: 11,
  driftGrip: 2.4,
  driftWide: 0.2,
  driftTight: 0.82,
  driftMinSpeed: 10,
  hopSpeed: 5.4,
  gravity: -34,
  maxFall: -42,
  tiers: [0.75, 1.65, 2.7],
  tierBoost: [0.55, 1.0, 1.5],
  boostSpeed: 32,
  boostAccel: 46,
  wallGlance: 0.6,
}

export const CONFIG = {
  race: {
    laps: 3,
    racers: 6,
    countdown: 3,
    /** Throttle held within this window before GO earns a start boost. */
    startBoostWindow: 0.45,
    /** Throttle held earlier than this (seconds before GO) stalls the engine briefly. */
    stallBefore: 1.6,
    killDepth: 14,
    respawnSeconds: 1.1,
    /** Seconds after the player finishes before the results screen. */
    resultsDelay: 3.2,
  },
  surface: {
    offroadSpeed: 0.74,
    offroadGrip: 0.85,
    fluffSpeed: 0.5,
  },
  items: {
    boxRespawn: 3.2,
    roulette: 1.1,
    shieldSeconds: 8,
    pepperSeconds: 1.7,
    pepperPower: 1.2,
    trapStick: 1.35,
    trapLife: 40,
    maxTraps: 10,
    beeSpeed: 40,
    beeLife: 9,
    beeSpin: 1.25,
    /** Distance at which a bee stops following the track and dives at its target. */
    beeHoming: 22,
    /** Triple Pepper: three separate pepper blasts. */
    tripleCount: 3,
    /** Gumball Bomb: fuse after the throw, blast radius, spin-out length. */
    bombFuse: 1.5,
    bombRadius: 7,
    bombSpin: 1.1,
    /** Sugar Rush: invulnerable, offroad-proof speed burst that bowls over rivals. */
    rushSeconds: 6.5,
    rushPower: 1.1,
  },
  coins: {
    /** Candy coins raise top speed slightly; hits knock some loose. */
    max: 10,
    perCoin: 0.004,
    respawn: 9,
    lose: 2,
    pickup: 1.7,
  },
  slip: {
    /** Slipstream: tuck in behind a rival to charge a small boost. */
    range: 15,
    lateral: 1.9,
    minSpeed: 15,
    charge: 1.25,
    seconds: 0.9,
    power: 1.05,
  },
  ai: {
    /** Catch-up: top-speed multiplier range relative to the player's track distance. */
    catchUpMax: 0.07,
    slowDownMax: 0.06,
    catchUpRange: 140,
    shortcutChance: [0.15, 0.35, 0.55, 0.7, 0.85],
  },
  camera: {
    fov: 64,
    boostFov: 80,
    distance: 6.2,
    height: 2.35,
    lookAhead: 5,
    follow: 9,
  },
} as const

export type ItemKind = 'shield' | 'pepper' | 'taffy' | 'bee' | 'triple' | 'bomb' | 'rush'
export const ITEM_KINDS: ItemKind[] = ['shield', 'pepper', 'taffy', 'bee', 'triple', 'bomb', 'rush']

export type Difficulty = 'easy' | 'normal' | 'hard'
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard']
/** Rival strength per difficulty: spline-driver skills (front → back), rubber band, pace, item reflexes. */
export const DIFFICULTY: Record<Difficulty, { skills: number[]; catchUpMax: number; slowDownMax: number; catchUpRange: number; pace: number; itemDelay: number }> = {
  easy: { skills: [0.8, 0.72, 0.64, 0.56, 0.5], catchUpMax: 0.03, slowDownMax: 0.09, catchUpRange: 140, pace: 0.965, itemDelay: 1.6 },
  normal: { skills: [0.92, 0.84, 0.76, 0.68, 0.6], catchUpMax: 0.07, slowDownMax: 0.06, catchUpRange: 140, pace: 1, itemDelay: 1 },
  hard: { skills: [0.99, 0.95, 0.9, 0.85, 0.8], catchUpMax: 0.1, slowDownMax: 0.025, catchUpRange: 160, pace: 1.025, itemDelay: 0.55 },
}

/** Character stats on a 1..5 scale; mapped to small spec deltas so every pick is viable. */
export type Stats = { speed: number; accel: number; handling: number; weight: number }

export function specFor(stats: Stats): KartSpec {
  const d = (v: number) => (v - 3) / 2 // -1..1
  return {
    ...BASE_KART,
    maxSpeed: BASE_KART.maxSpeed * (1 + d(stats.speed) * 0.035),
    boostSpeed: BASE_KART.boostSpeed * (1 + d(stats.speed) * 0.025),
    accel: BASE_KART.accel * (1 + d(stats.accel) * 0.14),
    turnRate: BASE_KART.turnRate * (1 + d(stats.handling) * 0.07),
    driftTight: BASE_KART.driftTight * (1 + d(stats.handling) * 0.05),
    grip: BASE_KART.grip * (1 + d(stats.handling) * 0.12),
    mass: 1 + d(stats.weight) * 0.35,
  }
}
