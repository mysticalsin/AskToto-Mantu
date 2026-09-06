/**
 * MQA-165 — the Cahê embedded-key gate has to scan the file that actually holds the key.
 *
 * electron-builder.cahe.win.yml copies build/cahe-embed → resources/cahe (encrypted kimi.json).
 * These tests drive the real script as a subprocess against a synthetic package.
 */
import { createPackageWithOptions } from '@electron/asar'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptProxyKey } from './lib/embedded-cloudflare-crypto.mjs'

const repoRoot = resolve(__dirname, '..')
const VALID_TOKEN = 'sk-kimi-QA165abcdefghijklmnop'
const KEYED_PLAIN = JSON.stringify({ kimiApiKey: VALID_TOKEN })
const KEYED_ENCRYPTED = JSON.stringify(encryptProxyKey(VALID_TOKEN))

let fixtureRoot: string
let script: string

async function buildPackage(name: string, caheBundle?: string): Promise<string> {
  const output = join(fixtureRoot, name)
  const resources = join(output, 'win-unpacked', 'resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(output, 'Metis-Windows-Cahe-Setup-1.2.3.exe'), 'NSIS installer fixture')
  writeFileSync(join(output, 'win-unpacked', 'Metis-Windows-Cahe.exe'), 'PE fixture')
  await createPackageWithOptions(join(fixtureRoot, 'stage'), join(resources, 'app.asar'), {})
  if (caheBundle !== undefined) {
    mkdirSync(join(resources, 'cahe'), { recursive: true })
    writeFileSync(join(resources, 'cahe', 'kimi.json'), caheBundle)
  }
  return output
}

function stageLocalEmbed(contents: string | null): void {
  const dir = join(fixtureRoot, 'build', 'cahe-embed')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'kimi.json')
  if (contents == null) {
    try {
      rmSync(p)
    } catch {
      /* absent is fine */
    }
    return
  }
  writeFileSync(p, contents)
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
  mkdirSync(join(fixtureRoot, 'scripts', 'lib'), { recursive: true })
  script = join(fixtureRoot, 'scripts', 'check-cahe-package.mjs')
  copyFileSync(join(repoRoot, 'scripts', 'check-cahe-package.mjs'), script)
  copyFileSync(
    join(repoRoot, 'scripts', 'lib', 'embedded-cloudflare-crypto.mjs'),
    join(fixtureRoot, 'scripts', 'lib', 'embedded-cloudflare-crypto.mjs')
  )
  // Material path is relative from scripts/lib → ../../src/main/embedded-key-material.json
  mkdirSync(join(fixtureRoot, 'src', 'main'), { recursive: true })
  copyFileSync(
    join(repoRoot, 'src', 'main', 'embedded-key-material.json'),
    join(fixtureRoot, 'src', 'main', 'embedded-key-material.json')
  )

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

describe('Cahê packaging gate — encrypted Kimi key (MQA-165 + encrypt wrap)', () => {
  it('refuses a plaintext kimiApiKey bundle even with METIS_CAHE_EMBED_KEY=1', async () => {
    stageLocalEmbed(KEYED_PLAIN)
    const output = await buildPackage('keyed-plain-refuse', KEYED_PLAIN)
    const { status, stderr } = runGate(output, '1')
    expect(status).not.toBe(0)
    expect(stderr + '').toMatch(/plaintext "kimiApiKey"|plaintext kimiApiKey/i)
  })

  it('refuses an encrypted embed without METIS_CAHE_EMBED_KEY=1', async () => {
    stageLocalEmbed(KEYED_ENCRYPTED)
    const output = await buildPackage('keyed-no-flag', KEYED_ENCRYPTED)
    const { status, stderr } = runGate(output)
    expect(status).not.toBe(0)
    expect(stderr).toContain('METIS_CAHE_EMBED_KEY=1')
  })

  it('allows an encrypted embed with METIS_CAHE_EMBED_KEY=1 and proves no plaintext leak', async () => {
    stageLocalEmbed(KEYED_ENCRYPTED)
    const output = await buildPackage('keyed-allowed', KEYED_ENCRYPTED)
    const { status, stdout, stderr } = runGate(output, '1')
    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(stdout).toContain('encrypted Cahê Kimi key explicitly allowed')
    expect(stdout).toContain('no plaintext token in package')
    expect(stdout).not.toContain(VALID_TOKEN)
  })

  it('passes a deliberately keyless build (no resources/cahe/kimi.json)', async () => {
    stageLocalEmbed(null)
    const output = await buildPackage('keyless')
    const { status, stdout, stderr } = runGate(output)
    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(stdout).toContain('no embedded Kimi key')
  })

  it('builder config + gate scan the cahe-embed → resources/cahe destination', () => {
    const config = readFileSync(join(repoRoot, 'electron-builder.cahe.win.yml'), 'utf8')
    const gate = readFileSync(join(repoRoot, 'scripts', 'check-cahe-package.mjs'), 'utf8')
    expect(config).toMatch(/from:\s*build\/cahe-embed/)
    expect(config).toMatch(/to:\s*cahe/)
    expect(gate).toContain("'win-unpacked', 'resources', 'cahe'")
    expect(gate).toContain('isEncryptedBlob')
    expect(gate).toContain('kimiApiKey')
  })
})
