import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SELF_TEST_FIXTURE } from '../src/main/features/components/speech-pack/manifest'
import { readSpeechPackProfile } from '../src/main/features/components/speech-pack/profile'

const root = join(__dirname, '..')
describe('speech-pack installer resources', () => {
  it('retains a standalone fixture matching the immutable recognition pin', () => {
    const fixture = readFileSync(join(root, 'resources', 'speech-pack-fixtures', 'en.wav'))
    expect(fixture.length).toBe(SELF_TEST_FIXTURE.bytes)
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(SELF_TEST_FIXTURE.sha256)
    const manifest = JSON.parse(readFileSync(join(root, 'resources', 'runtime-assets-manifest.json'), 'utf8'))
    expect(manifest.assets['resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav']).toEqual({
      bytes: SELF_TEST_FIXTURE.bytes,
      sha256: SELF_TEST_FIXTURE.sha256
    })
  })
  it('ships an explicit full profile until a separately qualified lean build exists', () => {
    expect(readSpeechPackProfile(join(root, 'build'), true)).toEqual({ profile: 'full' })
    const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(config).toMatch(/from: build\/speech-pack-profile\.json\s+to: speech-pack-profile\.json/)
    expect(config).toMatch(/from: resources\/speech-pack-fixtures\/en\.wav\s+to: speech-pack-fixtures\/en\.wav/)
  })
})
