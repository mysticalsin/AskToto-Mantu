import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { macHelperSpeechUsage } from './lib/mac-helper-privacy.mjs'

const helper = join(__dirname, '..', 'resources', 'mac-helper', 'metis-mac-helper')

describe.skipIf(process.platform !== 'darwin' || !existsSync(helper))('MQA-347 packaged macOS Speech helper privacy metadata', () => {
  it.each(['arm64', 'x86_64'])('embeds a nonempty Speech Recognition usage description in the %s slice', (arch) => {
    expect(macHelperSpeechUsage(helper, arch)).toMatch(/Métis transcribes meeting audio on-device/)
  })
})
