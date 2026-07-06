// Packaged-app smoke — launch release/win-unpacked/AskToto.exe via Playwright's Electron driver,
// wait for the overlay, screenshot, dump console, exit 1 on renderer errors. Proves the PACKAGED
// build boots: asar, extraResources (models/intelligence), sherpa native addon path, preload wiring.
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

const WT = 'D:/asktoto-wt'
const EXE = `${WT}/release/win-unpacked/AskToto.exe`
const OUT = process.argv[2] || `${WT}/.forge/boot`
mkdirSync(OUT, { recursive: true })

const consoleLines = []
const app = await electron.launch({
  executablePath: EXE,
  args: [],
  env: { ...process.env, ASKTOTO_DISABLE_CP: '1' },
  timeout: 90_000,
})
app.process().stderr?.on('data', (d) => consoleLines.push('[stderr] ' + d))

const win = await app.firstWindow({ timeout: 90_000 })
win.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
await win.waitForLoadState('domcontentloaded')
await new Promise((r) => setTimeout(r, 6000))
const title = await win.title()
const url = win.url()
const body = await win.evaluate(() => ({
  text: document.body.innerText.slice(0, 600),
  elements: document.querySelectorAll('*').length,
}))
await win.screenshot({ path: `${OUT}/overlay-packaged.png` })
console.log(JSON.stringify({ title, url, elements: body.elements, bodyText: body.text }, null, 2))
console.log('--- console (first 40) ---')
for (const l of consoleLines.slice(0, 40)) console.log(l)
const errors = consoleLines.filter((l) => l.startsWith('[error]') || /Uncaught|FATAL/i.test(l))
console.log(`--- errors: ${errors.length} ---`)
for (const e of errors) console.log(e)
await app.close()
process.exit(errors.length ? 1 : 0)
