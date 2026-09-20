import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ear = readFileSync(join(__dirname, 'metis-command-ear.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')

describe('Cap2 always-on command ear', () => {
  it('reuses Apple/Parakeet YOU feeds and never calls removed metisCommandIngest', () => {
    expect(ear).toContain('appleSpeechFeed')
    expect(ear).toContain('parakeetFeed')
    expect(ear).toContain("'you'")
    expect(ear).not.toContain('metisCommandIngest')
    expect(ear).toContain('startMetisCommandEar')
  })

  it('is armed from App after onboardingDone', () => {
    expect(app).toContain('startMetisCommandEar')
    expect(app).toContain('onboardingDone')
    expect(app).toMatch(/openPermissionSettings\?\.?\('microphone'\)|openPermissionSettings\?\.?\(\"microphone\"\)/)
  })

  it('main still ingests Cap2 from local YOU ASR', () => {
    expect(main).toContain("p.speaker === 'you'")
    expect(main).toContain('ingestMetisCommandFromAsr(text)')
  })
})
