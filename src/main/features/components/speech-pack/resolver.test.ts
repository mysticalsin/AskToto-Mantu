import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SPEECH_PACK_COMPONENTS, type SpeechPackComponent } from './manifest'
import { componentManifestIdentity, resolveSpeechPack } from './resolver'

const component = (files = [{ path: 'model.bin', bytes: 6, sha256: '0'.repeat(64) }]): SpeechPackComponent => ({
  id: 'asr.whisper-base-q8',
  version: '2',
  files,
  source: { kind: 'files', baseUrl: 'https://example.invalid/pinned' }
})

describe('speech-pack resolver', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'speech-pack-resolver-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('accepts a schema-2 marker bound to the exact component manifest and checks sizes without hashing weights', () => {
    const c = component()
    const pack = join(root, c.id, c.version)
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'model.bin'), 'abcdef')
    writeFileSync(join(root, c.id, 'active.json'), JSON.stringify({
      schema: 2,
      component: c.id,
      version: c.version,
      manifestIdentity: componentManifestIdentity(c)
    }))
    expect(resolveSpeechPack(root, c)).toMatchObject({ status: 'ready', manifestIdentity: componentManifestIdentity(c) })
  })

  it('requires explicit repair for legacy, unknown-field, wrong-manifest, wrong-size and symlink markers or files', () => {
    const c = component()
    const componentDir = join(root, c.id)
    const pack = join(componentDir, c.version)
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'model.bin'), 'abcdef')
    const markerPath = join(componentDir, 'active.json')
    const valid = { schema: 2, component: c.id, version: c.version, manifestIdentity: componentManifestIdentity(c) }
    const cases = [
      { schema: 1, component: c.id, version: c.version },
      { ...valid, extra: true },
      { ...valid, manifestIdentity: 'a'.repeat(64) }
    ]
    for (const marker of cases) {
      writeFileSync(markerPath, JSON.stringify(marker))
      expect(resolveSpeechPack(root, c).status).toBe('repair-needed')
    }
    writeFileSync(markerPath, JSON.stringify(valid))
    writeFileSync(join(pack, 'model.bin'), 'short')
    expect(resolveSpeechPack(root, c).status).toBe('repair-needed')
    writeFileSync(join(pack, 'model.bin'), 'abcdef')
    rmSync(join(pack, 'model.bin'))
    symlinkSync(join(root, 'outside.bin'), join(pack, 'model.bin'))
    writeFileSync(join(root, 'outside.bin'), 'abcdef')
    expect(resolveSpeechPack(root, c).status).toBe('repair-needed')
  })

  it('rejects staging, non-regular paths and path escapes without following them', () => {
    const c = component()
    const componentDir = join(root, c.id)
    mkdirSync(join(root, '.staging', c.id, c.version), { recursive: true })
    mkdirSync(join(componentDir, c.version), { recursive: true })
    writeFileSync(join(componentDir, 'active.json'), JSON.stringify({
      schema: 2, component: c.id, version: c.version, manifestIdentity: componentManifestIdentity(c)
    }))
    expect(resolveSpeechPack(root, c).status).toBe('repair-needed')
    const escaped = component([{ path: '../outside.bin', bytes: 6, sha256: '0'.repeat(64) }])
    expect(resolveSpeechPack(root, escaped).status).toBe('repair-needed')
  })

  it('derives identities from pinned manifest content, not object key order', () => {
    const c = component()
    expect(componentManifestIdentity(c)).toMatch(/^[0-9a-f]{64}$/)
    expect(componentManifestIdentity({ ...c, files: [...c.files].reverse() })).toBe(componentManifestIdentity(c))
    expect(SPEECH_PACK_COMPONENTS.length).toBeGreaterThan(0)
  })
})
