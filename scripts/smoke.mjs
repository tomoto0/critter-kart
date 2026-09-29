// End-to-end smoke test: builds must already exist in dist/ (`pnpm build`).
// Serves dist/, boots Critter Kart in headless Chromium, starts a race and drives a few
// seconds, checks pause/settings, forces a finish to reach the results, verifies English,
// Simplified Chinese and Japanese detection plus the phone HUD, fails on any console error,
// and writes screenshots to ./shots/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', detached: false })
let browser
const guard = setTimeout(() => fail('timed out'), 180_000)

function cleanup() {
  clearTimeout(guard)
  try { server.kill('SIGTERM') } catch {}
}
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}

const active = name => `[data-screen="${name}"].active`

async function openGame(context, errors) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForSelector(active('title'), { timeout: 60_000 })
  await page.evaluate(() => window.__game.save.update({ tutorialDone: true }))
  await page.waitForTimeout(900)
  return page
}

const state = page => page.evaluate(() => {
  const { game } = window.__game
  const p = game.racers.find(r => r.isPlayer).position
  return { mode: game.mode, phase: game.phase, raceTime: game.raceTime, pos: { x: p.x, y: p.y, z: p.z } }
})

async function startRace(page, tap = false) {
  const press = sel => (tap ? page.tap(sel) : page.click(sel))
  await press('[data-act="race"]')
  await page.waitForSelector(active('select'))
  await page.waitForTimeout(500)
  await press('[data-act="start"]')
  await page.waitForSelector(active('hud'))
  await page.evaluate(() => window.__game.game.skipIntro())
  await page.waitForFunction(() => window.__game.game.phase === 'racing', null, { timeout: 15_000 })
}

try {
  await waitForServer()
  // Prefer Playwright's bundled Chromium; fall back to an installed Google Chrome.
  const args = ['--ignore-gpu-blocklist']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  const en = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const page = await openGame(en, errors)
  await page.screenshot({ path: `${out}/01-title-en.png` })

  await page.click('[data-act="guide"]')
  await page.waitForSelector(active('guide'))
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/02-guide.png` })
  await page.keyboard.press('Escape')
  await page.waitForSelector(active('title'))

  await startRace(page)
  const before = await state(page)
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(2500)
  await page.keyboard.up('KeyW')
  await page.screenshot({ path: `${out}/03-gameplay.png` })
  const after = await state(page)
  const moved = Math.hypot(after.pos.x - before.pos.x, after.pos.z - before.pos.z)
  if (after.mode !== 'playing') throw new Error(`expected playing, got ${after.mode}`)
  if (!(after.raceTime > before.raceTime)) throw new Error('race clock did not run')
  if (moved < 5) throw new Error(`player barely moved (${moved.toFixed(2)} m)`)
  console.log(`smoke: moved ${moved.toFixed(1)} m in ${(after.raceTime - before.raceTime).toFixed(1)} s`)

  await page.keyboard.press('Escape')
  await page.waitForSelector(active('pause'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/04-pause.png` })
  await page.click(`${active('pause')} [data-act="settings"]`)
  await page.waitForSelector(active('settings'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/05-settings.png` })
  await page.keyboard.press('Escape')
  await page.waitForSelector(active('pause'))
  await page.waitForTimeout(300)
  if ((await state(page)).mode !== 'paused') throw new Error('leaving Settings with Escape resumed the race')
  await page.click(`${active('pause')} [data-act="resume"]`)
  await page.waitForFunction(() => window.__game.game.mode === 'playing')

  // Results: cross the line through the real finish handler.
  await page.evaluate(() => {
    const g = window.__game.game
    const p = g.racers.find(r => r.isPlayer)
    p.progress.finished = true
    p.progress.finishTime = g.raceTime
    p.progress.lapTimes = [g.raceTime]
    g.onProgress(p, 'finish', 3)
  })
  await page.waitForSelector(active('results'), { timeout: 15_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/06-results.png` })
  const rows = await page.locator(`${active('results')} .res-table ol li`).count()
  if (rows !== 6) throw new Error(`expected 6 result rows, got ${rows}`)
  await en.close()

  for (const [locale, lang] of [['zh-CN', 'zh-CN'], ['ja-JP', 'ja']]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale })
    const p = await openGame(ctx, errors)
    const got = await p.evaluate(() => document.documentElement.lang)
    if (got !== lang) throw new Error(`browser language ${locale} not detected (lang=${got})`)
    await p.screenshot({ path: `${out}/07-title-${lang}.png` })
    await ctx.close()
  }

  const phone = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  const phonePage = await openGame(phone, errors)
  await startRace(phonePage, true)
  await phonePage.waitForTimeout(1200)
  await phonePage.screenshot({ path: `${out}/08-phone-hud.png` })
  await phone.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
