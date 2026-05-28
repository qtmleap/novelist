import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import sharp from 'sharp'

type Viewport = {
  name: string
  width: number
  height: number
  deviceScaleFactor: number
}

type Scenario = {
  name: string
  path: string
  setup?: (page: Page) => Promise<void>
}

const SCENARIOS: Scenario[] = [
  { name: 'home', path: '/' },
  { name: 'planner', path: '/planner' },
  {
    name: 'planner-results',
    path: '/planner',
    async setup(page) {
      // Default form ships with origin=tokyo, waypoints=[kyoto/2, osaka/1]. Just submit.
      const submit = page.getByRole('button', { name: /見積もりを計算する/ })
      await submit.click()
      await page.waitForSelector('text=最安構成の合計', { timeout: 15000 })
      await page.waitForTimeout(400)
    }
  }
]

const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2 },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2 }
]

const BASE_URL = process.env.SNAPSHOT_BASE_URL ?? 'http://localhost:11675'
const OUT_DIR = join(process.cwd(), 'tests/snapshots')

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

async function captureScenario(browser: Browser, scenario: Scenario, viewport: Viewport): Promise<number> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor
  })
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}${scenario.path}`, { waitUntil: 'networkidle', timeout: 15000 })
    await page.waitForTimeout(300)
    if (scenario.setup) await scenario.setup(page)
    const png = await page.screenshot({ type: 'png', fullPage: true })
    const out = join(OUT_DIR, `${scenario.name}__${viewport.name}.webp`)
    const webp = await sharp(png).webp({ quality: 85, effort: 4 }).toBuffer()
    await Bun.write(out, webp)
    return webp.byteLength
  } finally {
    await context.close()
  }
}

async function main() {
  if (!(await isReachable(BASE_URL))) {
    console.error(`[snapshot-ui] dev server not reachable at ${BASE_URL}`)
    console.error('  start it with `bun run dev` in another terminal, then re-run this script.')
    process.exit(2)
  }

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  try {
    const startedAt = Date.now()
    const summary: { scenario: string; viewport: string; bytes: number }[] = []

    for (const vp of VIEWPORTS) {
      for (const scenario of SCENARIOS) {
        try {
          const bytes = await captureScenario(browser, scenario, vp)
          summary.push({ scenario: scenario.name, viewport: vp.name, bytes })
        } catch (e) {
          console.error(
            `[snapshot-ui] failed to capture ${scenario.name}/${vp.name}: ${e instanceof Error ? e.message : e}`
          )
        }
      }
    }

    const ms = Date.now() - startedAt
    console.log(`[snapshot-ui] saved ${summary.length} snapshots to ${OUT_DIR} in ${ms} ms`)
    for (const s of summary) {
      console.log(`  - ${s.scenario}/${s.viewport}: ${(s.bytes / 1024).toFixed(1)} KB`)
    }
  } finally {
    await browser.close()
  }
}

await main()
