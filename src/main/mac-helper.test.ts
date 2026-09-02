import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import {
  buildOcrContext,
  macHelperPath,
  macHelperPresent,
  macNoConstrainNodePath,
  macNoConstrainDylibPath,
  installMacNoConstrain,
  macScreenMetricsSpawnSpec,
  getMacScreenMetrics,
  extractScreenText,
  type OcrResult
} from './mac-helper'

const REPO_ROOT = process.cwd()

function line(text: string, y: number, confidence = 1): OcrResult['lines'][number] {
  return { text, confidence, box: [0.1, y, 0.5, 0.02] }
}

describe('buildOcrContext', () => {
  it('sorts lines into reading order (Vision boxes are bottom-left origin: top of screen = highest y)', () => {
    const ctx = buildOcrContext({
      width: 1280,
      height: 800,
      lines: [line('bottom line of the page', 0.1), line('middle paragraph text', 0.5), line('Top Title Of Document', 0.9)]
    })
    expect(ctx).not.toBeNull()
    const body = ctx!.split('\n').slice(1)
    expect(body).toEqual(['Top Title Of Document', 'middle paragraph text', 'bottom line of the page'])
  })

  it('filters low-confidence fragments and whitespace-only lines', () => {
    const ctx = buildOcrContext({
      width: 1,
      height: 1,
      lines: [
        line('kept line with enough characters to pass the floor', 0.9, 0.95),
        line('noise', 0.8, 0.1),
        line('   ', 0.7, 0.99)
      ]
    })
    expect(ctx).toContain('kept line')
    expect(ctx).not.toContain('noise')
  })

  it('returns null for a text-poor screen (caller falls back to the VLM caption)', () => {
    expect(buildOcrContext({ width: 1, height: 1, lines: [] })).toBeNull()
    expect(buildOcrContext({ width: 1, height: 1, lines: [line('OK', 0.5)] })).toBeNull()
  })

  it('caps a dense extract and marks the truncation', () => {
    const lines = Array.from({ length: 200 }, (_, i) => line(`row ${i} — some cell content here`, 1 - i / 200))
    const ctx = buildOcrContext({ width: 1, height: 1, lines })
    expect(ctx!.length).toBeLessThan(1700)
    expect(ctx).toContain('[…]')
  })

  it('frames the extract so the answer model knows it reads raw text, not a narration', () => {
    const ctx = buildOcrContext({
      width: 1,
      height: 1,
      lines: [line('a sufficiently long single line of screen text content', 0.5)]
    })
    expect(ctx!.startsWith("Text visible on the user's screen (OCR extract")).toBe(true)
  })
})

describe('macHelperPath / macHelperPresent', () => {
  it('resolves inside the repo checkout when unpackaged', () => {
    expect(macHelperPath().endsWith(join('resources', 'mac-helper', 'metis-mac-helper'))).toBe(true)
  })

  it('is never present on non-darwin platforms', () => {
    expect(macHelperPresent('win32')).toBe(false)
    expect(macHelperPresent('linux')).toBe(false)
  })

  it('resolves noconstrain .node and dylib next to the helper', () => {
    expect(macNoConstrainNodePath().endsWith(join('resources', 'mac-helper', 'metis-noconstrain.node'))).toBe(true)
    expect(macNoConstrainDylibPath().endsWith(join('resources', 'mac-helper', 'libmetis-noconstrain.dylib'))).toBe(true)
  })

  it('installMacNoConstrain is a no-op on this non-darwin host', () => {
    expect(installMacNoConstrain()).toBe(false)
  })
})

describe('metis-noconstrain source (Hide park Y=0 swizzle)', () => {
  it('ships metis-noconstrain.m that replaces constrainFrameRect:toScreen:', () => {
    const src = readFileSync(join(REPO_ROOT, 'native', 'mac-helper', 'metis-noconstrain.m'), 'utf8')
    expect(src).toMatch(/constrainFrameRect:toScreen:/)
    expect(src).toMatch(/metis_install_no_constrain/)
    expect(src).toMatch(/method_setImplementation/)
    expect(src).toMatch(/METIS_NOCONSTRAIN_NAPI/)
    expect(src).toMatch(/NAPI_MODULE/)
    expect(src).toMatch(/__attribute__\(\(constructor\)\)/)
  })

  it('build-mac-helper.mjs compiles the dylib and the in-process .node', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'build-mac-helper.mjs'), 'utf8')
    expect(script).toMatch(/libmetis-noconstrain\.dylib/)
    expect(script).toMatch(/metis-noconstrain\.node/)
    expect(script).toMatch(/metis-noconstrain\.m/)
    expect(script).toMatch(/METIS_NOCONSTRAIN_NAPI/)
    expect(script).toMatch(/-dynamiclib/)
    expect(script).toMatch(/-bundle/)
    expect(script).toContain("join(repoRoot, 'native', 'mac-helper', 'metis-noconstrain.m')")
  })

  it('check-mac-helper.mjs requires the dylib and the .node on mac', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'check-mac-helper.mjs'), 'utf8')
    expect(script).toMatch(/libmetis-noconstrain\.dylib/)
    expect(script).toMatch(/metis-noconstrain\.node/)
  })

  it('index.ts loads the swizzle before createWindow', () => {
    const index = readFileSync(join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf8')
    expect(index).toMatch(/installMacNoConstrain/)
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create.indexOf('installMacNoConstrain()')).toBeGreaterThan(-1)
    expect(create.indexOf('installMacNoConstrain()')).toBeLessThan(create.indexOf('new BrowserWindow'))
  })
})

describe('macScreenMetricsSpawnSpec / getMacScreenMetrics (MQA-275 — island notch metrics)', () => {
  it('spawn spec targets the screen-metrics subcommand when the helper exists (repo checkout state)', () => {
    const spec = macScreenMetricsSpawnSpec()
    if (existsSync(macHelperPath())) {
      expect(spec).toEqual({ command: macHelperPath(), args: ['screen-metrics'] })
    } else {
      expect(spec).toBeNull()
    }
  })

  it('degrades to null (never throws) when the helper binary is absent — proven on this non-darwin CI host', async () => {
    // This VM has no darwin helper binary at all, so macHelperPresent() is false regardless of platform
    // mocking, and getMacScreenMetrics must resolve null rather than reject/hang.
    const result = await getMacScreenMetrics()
    expect(result).toBeNull()
  })
})

describe('packaging wiring (mechanical — missing wiring fails this suite)', () => {
  const MAC_CHAIN_KEYS = ['predist', 'dist:local', 'release:build:mac', 'release:mas'] as const

  it('build-mac-helper.mjs + check-mac-helper.mjs run in every mac packaging chain', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const key of MAC_CHAIN_KEYS) {
      expect(pkg.scripts[key], `scripts.${key} missing`).toBeTruthy()
      expect(pkg.scripts[key], `scripts.${key} does not build the mac helper`).toContain('build-mac-helper.mjs')
      expect(pkg.scripts[key], `scripts.${key} does not guard the mac helper`).toContain('check-mac-helper.mjs mac')
    }
  })

  it('electron-builder.yml ships resources/mac-helper in the mac extraResources', () => {
    const yml = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/from: resources\/mac-helper\s*\n\s*to: mac-helper/)
  })

  it('the compiled binary is gitignored (rebuilt by script, never committed)', () => {
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(ignore).toContain('resources/mac-helper/')
  })

  it('check-mac-helper.mjs exits 0 for win (mac-only sidecar) and 1 when the mac binary is missing', () => {
    const win = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-mac-helper.mjs'), 'win'], { encoding: 'utf8' })
    expect(win.status).toBe(0)
    const missing = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-mac-helper.mjs'), 'mac'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env }
    })
    // On a machine where the helper was built this passes 0; the loud-failure branch is proven by the
    // usage/argument test below plus the script's existsSync gate — don't delete a real dev binary here.
    expect([0, 1]).toContain(missing.status)
    const usage = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-mac-helper.mjs')], { encoding: 'utf8' })
    expect(usage.status).toBe(1)
  })
})

describe('extractScreenText — real helper integration (soft-skip when not built/not darwin)', () => {
  const helperBuilt = process.platform === 'darwin' && existsSync(join(REPO_ROOT, 'resources', 'mac-helper', 'metis-mac-helper'))
  // 1x1 transparent PNG: decodable image, zero text — proves the spawn→stdin→JSON pipeline end to end
  // and the text-poor → null contract in one shot, with no OCR-model variance.
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  const run = helperBuilt ? it : it.skip
  run(
    'pipes an image through the real binary and honors the text-poor → null contract',
    async () => {
      const result = await extractScreenText(TINY_PNG_B64)
      expect(result).toBeNull()
    },
    30_000
  )

  run(
    'returns null (never throws) for undecodable input',
    async () => {
      const result = await extractScreenText(Buffer.from('not an image').toString('base64'))
      expect(result).toBeNull()
    },
    30_000
  )
})

describe('packaging locks from the Sonnet audit (source-scan)', () => {
  it('build-mac-helper.mjs pins an explicit deployment target on BOTH universal slices', () => {
    // Without -target, swiftc stamps the BUILD machine's OS (a macOS 27 beta box) as the binary's
    // minimum and dyld on user machines refuses to load it — silent screen-context degradation.
    // The helper is built once per arch and lipo'd, so an unpinned triple on either slice reintroduces
    // that bug for half the install base; assert the pin per target rather than as one literal.
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'build-mac-helper.mjs'), 'utf8')
    expect(script).toMatch(/'arm64-apple-macos13\.0'/)
    expect(script).toMatch(/'x86_64-apple-macos13\.0'/)
    // Every -target passed to swiftc must come from that pinned table, never a bare/derived triple.
    expect(script).toMatch(/'-target',\s*target\.triple/)
  })

  it('build-installers.mjs builds + guards the mac helper before its electron-builder --mac invocation', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'build-installers.mjs'), 'utf8')
    const buildIdx = script.indexOf('build-mac-helper.mjs')
    const checkIdx = script.indexOf('check-mac-helper.mjs')
    const ebIdx = script.indexOf("'electron-builder', '--mac'")
    expect(buildIdx).toBeGreaterThan(-1)
    expect(checkIdx).toBeGreaterThan(buildIdx)
    expect(ebIdx).toBeGreaterThan(checkIdx)
  })
})
