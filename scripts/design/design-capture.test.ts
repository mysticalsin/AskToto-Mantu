import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESIGN_CAPTURE_ENTRY, rendererInputs } from './renderer-inputs'
import {
  MOTIONS,
  SCALES,
  THEMES,
  buildManifest,
  captureDeviceMetrics,
  captureFileName,
  captureMatrix,
  captureScreenshotRequest,
  assertPngSize,
  pngSize,
  sha256Hex
} from './capture-manifest.mjs'
import { AUDIT_STANDARD, contrastRatio } from './capture-audit.mjs'
import {
  AUDIT_NEGATIVE_CONTROL_STATE,
  DESIGN_STATES,
  DESIGN_STATE_IDS,
  resolveDesignState,
  resolveDesignStateIncludingQa
} from '../../src/renderer/src/design-capture/states'

const root = resolve(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

/** The `- 'pattern'` entries of every `files:` list in a packaging config, whatever its indent. */
function fileLists(config: string): string[][] {
  const lines = config.split('\n')
  const lists: string[][] = []
  for (let i = 0; i < lines.length; i++) {
    const header = /^( *)files:\s*$/.exec(lines[i])
    if (!header) continue
    const list: string[] = []
    for (const line of lines.slice(i + 1)) {
      const item = /^ *- '?([^'#]+?)'?\s*$/.exec(line)
      if (item) list.push(item[1])
      else if (!/^ *#/.test(line)) break
    }
    lists.push(list)
  }
  return lists
}

/** True when a `!`-negated `files` entry (only `*` wildcards used here) excludes the path. */
function excludes(list: string[], path: string): boolean {
  return list
    .filter((entry) => entry.startsWith('!'))
    .some((entry) => {
      const pattern = entry
        .slice(1)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
      return new RegExp(`^${pattern}$`).test(path)
    })
}

describe('design-capture renderer entry', () => {
  const rendererRoot = join(root, 'src', 'renderer')

  it('is not built without METIS_DESIGN_CAPTURE=1', () => {
    for (const env of [{}, { METIS_DESIGN_CAPTURE: '' }, { METIS_DESIGN_CAPTURE: '0' }]) {
      expect(Object.keys(rendererInputs(rendererRoot, env))).toEqual(['index', 'decoder'])
    }
  })

  it('is built when METIS_DESIGN_CAPTURE=1', () => {
    const inputs = rendererInputs(rendererRoot, { METIS_DESIGN_CAPTURE: '1' })
    expect(inputs[DESIGN_CAPTURE_ENTRY]).toBe(join(rendererRoot, 'design-capture.html'))
    expect(inputs.index).toBe(join(rendererRoot, 'index.html'))
  })

  it('is excluded from the packaged file list of every installer config, wherever it is emitted', () => {
    const emitted = [
      'out/renderer/design-capture.html',
      'out/renderer/assets/design-capture-Bx3k9Q.js',
      'out/renderer/assets/design-capture-Bx3k9Q.css'
    ]
    const configs = ['electron-builder.yml', 'electron-builder.win.yml']
    let checked = 0
    for (const config of configs) {
      const lists = fileLists(read(config))
      expect(lists.length, config).toBeGreaterThan(0)
      for (const list of lists) {
        expect(list, config).toContain('out/**/*')
        for (const path of emitted) expect(excludes(list, path), `${config}: ${path}`).toBe(true)
        // The app's own renderer stays in.
        expect(excludes(list, 'out/renderer/index.html'), config).toBe(false)
        checked++
      }
    }
    // Base list, the mac override and the Windows list: a new packaging list must be added here on purpose.
    expect(checked).toBe(3)
  })
})

describe('design states', () => {
  it('has unique ids and resolves each from a query string', () => {
    expect(new Set(DESIGN_STATE_IDS).size).toBe(DESIGN_STATES.length)
    for (const s of DESIGN_STATES) expect(resolveDesignState(`?state=${s.id}`)).toBe(s)
  })

  it('resolves nothing for a missing or unknown state', () => {
    expect(resolveDesignState('')).toBeUndefined()
    expect(resolveDesignState('?state=nope')).toBeUndefined()
  })

  it('keeps the QA audit negative control out of evidence state ids', () => {
    expect(DESIGN_STATE_IDS).not.toContain(AUDIT_NEGATIVE_CONTROL_STATE.id)
    expect(resolveDesignState(`?state=${AUDIT_NEGATIVE_CONTROL_STATE.id}`)).toBeUndefined()
    expect(resolveDesignStateIncludingQa(`?state=${AUDIT_NEGATIVE_CONTROL_STATE.id}`)).toBe(
      AUDIT_NEGATIVE_CONTROL_STATE
    )
  })
})

describe('audit negative-control CSS', () => {
  let browser: Browser

  beforeAll(async () => {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('keeps the low-contrast text color active in both capture themes', async () => {
    const styles = `${read('src/renderer/src/tokens.css')}\n${read('src/renderer/src/design-capture/capture.css')}`

    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ colorScheme, viewport: { width: 960, height: 640 } })
      try {
        await page.setContent(
          `<!doctype html><html class="design-capture"><head><style>${styles}</style></head><body><div id="root"><div class="dc-card dc-audit-negative"><p class="dc-audit-negative-text">Contrast guard sample</p></div></div></body></html>`,
          { waitUntil: 'domcontentloaded' }
        )
        const computed = await page.locator('.dc-audit-negative-text').evaluate((element: any) => {
          const view = element.ownerDocument.defaultView
          const text = view.getComputedStyle(element)
          const card = view.getComputedStyle(element.closest('.dc-audit-negative'))
          return { color: text.color, background: card.backgroundColor }
        })
        expect(computed, colorScheme).toEqual({
          color: 'rgb(119, 119, 119)',
          background: 'rgb(255, 255, 255)'
        })
        expect(contrastRatio(computed.color, computed.background), colorScheme).toBeLessThan(4.5)
      } finally {
        await page.close()
      }
    }
  })
})

describe('capture matrix and manifest', () => {
  const cleanAudit = {
    pass: true,
    text: { checked: 1, failures: [] },
    nonText: { checked: 1, failures: [] },
    clipping: { checked: 1, failures: [] },
    unverifiable: []
  }

  it('covers light/dark x 1x/2x x reduced motion exactly once each', () => {
    const rows = captureMatrix()
    expect(rows).toHaveLength(THEMES.length * SCALES.length * MOTIONS.length)
    expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(rows.length)
    expect(THEMES).toEqual(['light', 'dark'])
    expect(SCALES).toEqual([1, 2])
    expect(MOTIONS).toEqual(['no-preference', 'reduce'])
  })

  it('names every shot uniquely across states and matrix rows', () => {
    const names = DESIGN_STATE_IDS.flatMap((id) => captureMatrix().map((row) => captureFileName(id, row)))
    expect(new Set(names).size).toBe(names.length)
    expect(captureFileName('bar-idle', { theme: 'dark', scale: 2, motion: 'reduce' })).toBe(
      'bar-idle__dark__2x__reduced-motion.png'
    )
  })

  it('records state, sha256 and commit for each image', () => {
    const bytes = new TextEncoder().encode('png-bytes')
    const manifest = buildManifest({
      commit: 'abc123',
      platform: 'darwin',
      shots: [
        {
          state: 'bar-idle',
          theme: 'light',
          scale: 1,
          motion: 'no-preference',
          file: 'a.png',
          bytes,
          audit: cleanAudit
        }
      ],
      negativeControl: { detected: true, kinds: ['clipping', 'nonText', 'text'] }
    })
    expect(manifest.commit).toBe('abc123')
    expect(manifest.entries).toEqual([
      {
        state: 'bar-idle',
        theme: 'light',
        scale: 1,
        motion: 'no-preference',
        file: 'a.png',
        sha256: sha256Hex(bytes),
        audit: cleanAudit
      }
    ])
    expect(manifest.entries[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.audit).toMatchObject({
      standard: AUDIT_STANDARD,
      failures: 0,
      text: { checked: 1, failures: 0 },
      nonText: { checked: 1, failures: 0 },
      clipping: { checked: 1, failures: 0 },
      unverifiable: 0,
      negativeControl: { detected: true, kinds: ['clipping', 'nonText', 'text'] }
    })
  })

  it('marks only reduced-motion shots as reproducible', () => {
    expect(
      buildManifest({
        commit: 'abc123',
        platform: 'darwin',
        shots: [],
        negativeControl: { detected: true, kinds: ['clipping', 'nonText', 'text'] }
      }).reproducibleMotions
    ).toEqual(['reduce'])
  })
})

describe('design-capture workflow', () => {
  const workflow = read('.github/workflows/design-capture.yml')

  it('runs on pull requests to integration when design-capture paths change and keeps dispatch support', () => {
    expect(workflow).toContain('  pull_request:\n    branches: [m2/integration]\n    paths:')
    expect(workflow).toContain('      - src/renderer/src/design-capture/**')
    expect(workflow).toContain('      - scripts/design/**')
    expect(workflow).toContain('      - .github/workflows/design-capture.yml')
    expect(workflow).toContain('  workflow_dispatch:')
    expect(workflow).not.toMatch(/\n  push:/)
  })

  it('captures on pull_request and always uploads the manifest artifact', () => {
    expect(workflow).not.toContain("if: github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('node scripts/design/capture-states.mjs out-design-capture')
  })
})

describe('capture driver', () => {
  // capture-states.mjs launches Electron at import, so its evidence-loop order is pinned on the source text.
  const driver = read('scripts/design/capture-states.mjs')

  it('takes each evidence screenshot before the audit collector can focus controls', () => {
    const evidenceLoop = driver.slice(driver.indexOf('for (const row of captureMatrix())'))
    const screenshot = evidenceLoop.indexOf("cdp.send('Page.captureScreenshot'")
    const audit = evidenceLoop.indexOf('await collectAudit(page)')
    expect(screenshot).toBeGreaterThan(-1)
    expect(audit).toBeGreaterThan(-1)
    expect(screenshot).toBeLessThan(audit)
  })
})

describe('png size check', () => {
  const png = (width: number, height: number): Buffer => {
    const b = Buffer.alloc(24)
    b.writeUInt32BE(0x89504e47, 0)
    b.writeUInt32BE(width, 16)
    b.writeUInt32BE(height, 20)
    return b
  }
  const viewport = { width: 960, height: 640 }

  it('reads the pixel size from the header', () => {
    expect(pngSize(png(1920, 1280))).toEqual({ width: 1920, height: 1280 })
  })

  it('accepts a shot at scale x viewport and rejects a silent 1x capture as 2x', () => {
    expect(() => assertPngSize(png(1920, 1280), viewport, 2, 'a.png')).not.toThrow()
    expect(() => assertPngSize(png(960, 640), viewport, 2, 'a.png')).toThrow(/expected 1920x1280, got 960x640/)
  })

  it('requests a CDP screenshot clip scaled to the expected output pixels', () => {
    expect(captureScreenshotRequest(viewport, 2)).toEqual({
      format: 'png',
      fromSurface: true,
      clip: {
        x: 0,
        y: 0,
        width: 960,
        height: 640,
        scale: 2
      }
    })
  })

  it('pins CDP device metrics to the capture viewport and leaves output scaling to the screenshot clip', () => {
    expect(captureDeviceMetrics(viewport)).toEqual({
      width: 960,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false
    })
  })

  it('rejects bytes that are not a PNG', () => {
    expect(() => pngSize(Buffer.alloc(30))).toThrow(/Not a PNG/)
  })
})
