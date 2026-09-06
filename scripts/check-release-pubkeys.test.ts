import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const script = join(root, 'scripts', 'check-release.mjs')

describe('check:release production pubkey gate (HIGH#2)', () => {
  it('electron-builder.yml ships operator and license-lease extraResources', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('from: resources/operator')
    expect(yml).toContain('to: operator')
    expect(yml).toContain('from: resources/license-lease')
    expect(yml).toContain('to: license-lease')
  })

  it('check-release.mjs embeds the production pubkey fail-closed scanner', () => {
    const src = readFileSync(script, 'utf8')
    expect(src).toContain('checkProductionPubkeys')
    expect(src).toContain('DEV_OPERATOR_PUBLIC_KEY')
    expect(src).toContain('DEV_LEASE_PUBLIC_KEY')
    expect(src).toContain('still equals the DEV')
  })

  it('fails closed when production pubkey.json files are missing', () => {
    const op = join(root, 'resources', 'operator', 'pubkey.json')
    const lease = join(root, 'resources', 'license-lease', 'pubkey.json')
    const missing = !existsSync(op) || !existsSync(lease)
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, ASKTOTO_ARTIFACTS_DIR: '' }
    })
    const out = `${result.stdout}\n${result.stderr}`
    if (missing) {
      expect(result.status).not.toBe(0)
      expect(out).toMatch(/pubkey\.json|Operator skill|license-lease|DEV/)
    } else {
      expect(out).not.toMatch(/still equals the DEV/)
    }
  })

  it('runtime modules refuse DEV fallback when packaged', () => {
    const op = readFileSync(join(root, 'src/main/operator-skill-key.ts'), 'utf8')
    const lease = readFileSync(join(root, 'src/main/license-lease-key.ts'), 'utf8')
    expect(op).toMatch(/const DEV_OPERATOR_PUBLIC_KEY = '[^']+'/)
    expect(lease).toMatch(/const DEV_LEASE_PUBLIC_KEY = '[^']+'/)
    expect(op).toContain('isPackagedBuild')
    expect(lease).toContain('isPackagedBuild')
    expect(op).toContain('Refusing the DEV fallback')
    expect(lease).toContain('Refusing the DEV fallback')
  })
})
