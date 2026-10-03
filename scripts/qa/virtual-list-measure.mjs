import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const outDir = resolve(arg('--out', 'out/m2-0075-virtual-list'))
const entry = resolve(arg('--entry', 'out/renderer/virtual-list-measure.html'))

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(entry).href)
  await page.waitForFunction(() => typeof window.__virtualListMeasure === 'function')
  const report = await page.evaluate(() => window.__virtualListMeasure())
  await writeFile(resolve(outDir, 'virtual-list-measure.json'), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    `# M2-0075 virtual-list measurement: ${report.verdict}`,
    '',
    `Budget: ${report.budgetMs} ms of main-thread work per animation frame.`,
    '',
    '| Surface | Rows | Rendered rows | Frames | Max frame work | Avg frame work |',
    '|---|---:|---:|---:|---:|---:|',
    ...report.results.map((r) =>
      `| ${r.surface} | ${r.rows} | ${r.renderedRows} | ${r.frames} | ${r.maxFrameWorkMs.toFixed(3)} ms | ${r.avgFrameWorkMs.toFixed(3)} ms |`
    ),
    ''
  ]
  await writeFile(resolve(outDir, 'virtual-list-measure.md'), `${lines.join('\n')}\n`)
  if (report.verdict !== 'PASS') {
    console.error(JSON.stringify(report, null, 2))
    process.exitCode = 1
  } else {
    console.log(`[virtual-list] PASS: wrote ${outDir}`)
  }
} finally {
  await browser.close()
}
