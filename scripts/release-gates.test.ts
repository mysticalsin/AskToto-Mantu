import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  description: string
  scripts: Record<string, string>
  devDependencies: Record<string, string>
  engines: { node: string }
}

describe('installer branding', () => {
  it('uses a customer-facing Métis file description without internal migration notes', () => {
    expect(pkg.description).toBe('Métis - AI desktop overlay assistant')
  })
})

describe('deterministic packaging toolchain', () => {
  it('pins the audited Electron build stack exactly', () => {
    expect(pkg.devDependencies['@electron/asar']).toBe('3.4.1')
    expect(pkg.devDependencies.electron).toBe('39.8.10')
    expect(pkg.devDependencies['electron-builder']).toBe('26.15.3')
    expect(pkg.devDependencies['electron-vite']).toBe('5.0.0')
    expect(pkg.devDependencies.vite).toBe('7.3.6')
  })

  it('uses the same supported Node LTS patch across local development and CI', () => {
    const expected = '22.22.3'
    expect(pkg.engines.node).toBe(expected)
    expect(readFileSync(join(root, '.nvmrc'), 'utf8').trim()).toBe(expected)
    expect(readFileSync(join(root, '.node-version'), 'utf8').trim()).toBe(expected)
    for (const workflow of ['build.yml', 'release.yml']) {
      const source = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8')
      const pins = [...source.matchAll(/node-version:\s*([\d.]+)/g)].map((match) => match[1])
      expect(pins.length).toBeGreaterThan(0)
      expect(new Set(pins)).toEqual(new Set([expected]))
    }
  })

  it('pins the official Electron checksums needed by offline Mac and Windows builds', () => {
    const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')) as {
      version: string
    }
    const officialChecksums = JSON.parse(
      readFileSync(join(root, 'node_modules/electron/checksums.json'), 'utf8')
    ) as Record<string, string>

    for (const target of ['darwin-arm64', 'win32-x64']) {
      const file = `electron-v${electron.version}-${target}.zip`
      expect(builderConfig).toContain(`${file}: ${officialChecksums[file]}`)
    }
  })

  it('does not package Dust client server dependencies that Métis never imports', () => {
    const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(pkg.scripts.postinstall).toBe('node scripts/prune-dust-bundle.mjs')
    for (const dependency of ['@modelcontextprotocol/sdk', 'express-rate-limit', 'ip-address']) {
      expect(builderConfig).toContain(
        `!node_modules/@dust-tt/client/node_modules/${dependency}{,/**/*}`
      )
    }
  })

  it('uses electron-vite 5 configuration instead of its deprecated plugin shims', () => {
    const viteConfig = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(viteConfig).not.toContain('externalizeDepsPlugin')
    expect(viteConfig).not.toContain('bytecodePlugin')
    expect(viteConfig).toContain('bytecode: true')
    expect(viteConfig).toContain("externalizeDeps: { exclude: ['zod'] }")
  })
})

describe('direct release signing gates', () => {
  it('requires an explicit expected Windows signer identity', () => {
    const result = spawnSync(process.execPath, [join(__dirname, 'check-release-secrets.mjs'), 'win'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        GH_TOKEN: 'test-token',
        WIN_CSC_LINK: 'test-certificate',
        WIN_CSC_KEY_PASSWORD: 'test-password'
      }
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WIN_CSC_EXPECTED_SUBJECT')
  })

  it('verifies produced signatures in both direct release commands', () => {
    expect(pkg.scripts['release:build:mac']).toContain('node scripts/verify-signing.mjs --require-notarized')
    expect(pkg.scripts['release:build:win']).toContain('node scripts/verify-signing.mjs')
  })
})
