/**
 * MQA-165 — the Cahê embedded-key gate has to scan the file that actually holds the key.
 *
 * `electron-builder.cahe.win.yml` copies `build/cahe-kimi.local.json` to `cahe/kimi.json` as an
 * extraResource, i.e. to `win-unpacked/resources/cahe/kimi.json`, OUTSIDE `app.asar`. Inside the NSIS
 * `.exe` that same file exists only within the LZMA-compressed `app-64.7z` payload, so a raw latin1
 * byte scan of the installer cannot see it either. The gate used to scan exactly those two artifacts,
 * which meant a package that provably ships a live `sk-kimi-…` key was reported as
 * "no embedded Kimi key" — the documented hard refusal could never fire, and the sanctioned
 * `METIS_CAHE_EMBED_KEY=1` build never printed the extractability warning it is supposed to.
 *
 * These tests drive the real script as a subprocess against a synthetic package.
 *
 * The fixture builds its own repository root (a temp dir under `node_modules/`, so it is gitignored and
 * `@electron/asar` still resolves from the repo) and runs a COPY of the script from it. The script
 * compares the packaged main-process loader/bytecode against `<repoRoot>/out/main/index.{js,jsc}` —
 * build output that a fresh clone or a git worktree does not have — and those reads happen before the
 * key scan. Pointing the script at a fixture root keeps the test hermetic instead of silently
 * depending on whether someone ran `npm run build` first.
 */
import { createPackageWithOptions } from '@electron/asar'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..')
const KEYED_BUNDLE = JSON.stringify({ kimiApiKey: 'sk-kimi-QA165abcdefghijklmnop' })

let fixtureRoot: string
let script: string

/**
 * Lay down a package that passes every check ahead of the key scan: one installer, the unpacked
 * executable, and an app.asar whose main-process loader and bytecode are byte-identical to the fixture
 * root's `out/main/`. `caheBundle` seeds `resources/cahe/kimi.json`; omitting it models the deliberately
 * keyless build (METIS_CAHE_ALLOW_KEYLESS=1), which produces no `cahe/` directory at all.
 */
async function buildPackage(name: string, caheBundle?: string): Promise<string> {
  const output = join(fixtureRoot, name)
  const resources = join(output, 'win-unpacked', 'resources')
  mkdirSync(resources, { recursive: true })
  // The installer is a plain file here, and deliberately carries no key: the real NSIS payload is
  // compressed, so the .exe scan is a net for an uncompressed accident, never coverage of the key.
  writeFileSync(join(output, 'Metis-Windows-Cahe-Setup-1.2.3.exe'), 'NSIS installer fixture')
  writeFileSync(join(output, 'win-unpacked', 'Metis-Windows-Cahe.exe'), 'PE fixture')
  await createPackageWithOptions(join(fixtureRoot, 'stage'), join(resources, 'app.asar'), {})
  if (caheBundle !== undefined) {
    mkdirSync(join(resources, 'cahe'), { recursive: true })
    writeFileSync(join(resources, 'cahe', 'kimi.json'), caheBundle)
  }
  return output
}

function runGate(output: string, embedFlag?: string): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env }
  delete env.METIS_CAHE_EMBED_KEY
  if (embedFlag !== undefined) env.METIS_CAHE_EMBED_KEY = embedFlag
  const result = spawnSync(process.execPath, [script, output], { encoding: 'utf8', env })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(repoRoot, 'node_modules', '.cahe-gate-'))
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true })
  script = join(fixtureRoot, 'scripts', 'check-cahe-package.mjs')
  copyFileSync(join(repoRoot, 'scripts', 'check-cahe-package.mjs'), script)

  const loader = 'require("./index.jsc")\n'
  const bytecode = 'cahe-gate-fixture-bytecode'
  for (const dir of [join(fixtureRoot, 'out', 'main'), join(fixtureRoot, 'stage', 'out', 'main')]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.js'), loader)
    writeFileSync(join(dir, 'index.jsc'), bytecode)
  }
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('Cahê packaging gate — embedded Kimi key scan (MQA-165)', () => {
  it('MQA-165 — refuses a package whose resources/cahe bundle embeds a Kimi key', async () => {
    const output = await buildPackage('keyed-refuse', KEYED_BUNDLE)

    const { status, stdout, stderr } = runGate(output)

    expect(status).not.toBe(0)
    expect(stderr).toContain('Refusing Cahê package with an embedded Kimi API key')
    expect(stderr).toContain('kimi.json')
    expect(stdout).not.toContain('no embedded Kimi key')
  })

  it('MQA-165 — names the packaged key file in the extractability warning when METIS_CAHE_EMBED_KEY=1', async () => {
    const output = await buildPackage('keyed-allowed', KEYED_BUNDLE)

    const { status, stdout } = runGate(output, '1')

    expect(status).toBe(0)
    expect(stdout).toContain('Found in: kimi.json')
    expect(stdout).toContain('embedded Kimi key explicitly allowed')
    expect(stdout).not.toContain('no embedded Kimi key')
  })

  it('MQA-165 — passes a deliberately keyless build, which ships no resources/cahe directory', async () => {
    const output = await buildPackage('keyless')

    const { status, stdout, stderr } = runGate(output)

    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(stdout).toContain('no embedded Kimi key')
  })

  it('MQA-165 — scans the extraResources destination the Cahê builder config actually writes to', () => {
    // If the `to:` destination ever moves, the gate's scan root has to move with it or the refusal
    // above goes back to being unreachable while still printing "no embedded Kimi key".
    const config = readFileSync(join(repoRoot, 'electron-builder.cahe.win.yml'), 'utf8')
    const gate = readFileSync(join(repoRoot, 'scripts', 'check-cahe-package.mjs'), 'utf8')

    expect(config).toMatch(/to:\s*cahe\/kimi\.json/)
    expect(gate).toContain("'win-unpacked', 'resources', 'cahe'")
  })
})
