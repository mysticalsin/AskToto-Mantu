import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSpeechPackProfile } from './profile'

describe('speech-pack build profile', () => {
  let resources: string

  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'speech-pack-profile-'))
  })
  afterEach(() => rmSync(resources, { recursive: true, force: true }))

  it('treats a missing packaged manifest as legacy full and scopes development explicitly', async () => {
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: 'full' })
    await expect(readSpeechPackProfile(resources, false)).resolves.toEqual({ profile: 'development' })
  })

  it('accepts only the exact build-emitted schema and profile values', async () => {
    const path = join(resources, 'speech-pack-profile.json')
    for (const profile of ['full', 'lean']) {
      writeFileSync(path, JSON.stringify({ schema: 1, profile }))
      await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile })
    }
    for (const invalid of [
      '{',
      JSON.stringify({ schema: 2, profile: 'lean' }),
      JSON.stringify({ schema: 1, profile: 'unknown' }),
      JSON.stringify({ schema: 1, profile: 'lean', extra: true }),
      JSON.stringify({ schema: 1, profile: 'lean', manifestIdentity: 'a'.repeat(64) })
    ]) {
      writeFileSync(path, invalid)
      await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: null, error: 'invalid-profile' })
    }
  })

  it('does not retain a default or valid profile across later filesystem changes', async () => {
    const path = join(resources, 'speech-pack-profile.json')
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: 'full' })
    writeFileSync(path, JSON.stringify({ schema: 1, profile: 'lean' }))
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: 'lean' })
    writeFileSync(path, '{')
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: null, error: 'invalid-profile' })
  })

  it('fails closed on symlink, non-file, oversized or unreadable profile manifests', async () => {
    const path = join(resources, 'speech-pack-profile.json')
    writeFileSync(path, JSON.stringify({ schema: 1, profile: 'lean' }))
    const outside = join(resources, 'profile-outside.json')
    writeFileSync(outside, JSON.stringify({ schema: 1, profile: 'lean' }))
    rmSync(path)
    symlinkSync(outside, path)
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: null, error: 'invalid-profile' })
    rmSync(path)
    mkdirSync(path)
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: null, error: 'invalid-profile' })
    rmSync(path, { recursive: true })
    writeFileSync(path, ' '.repeat(129))
    await expect(readSpeechPackProfile(resources, true)).resolves.toEqual({ profile: null, error: 'invalid-profile' })
  })
})
