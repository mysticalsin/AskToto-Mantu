import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ear = readFileSync(join(__dirname, 'metis-command-ear.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')

describe('Cap2 always-on command ear', () => {
  it('resumes AudioContext and uses silent sink', () => {
    expect(ear).toContain('ctx.resume')
    expect(ear).toContain('gain.value = 0')
    expect(ear).toContain('appleSpeechFeed')
    expect(ear).toContain('parakeetFeed')
    expect(ear).not.toContain('metisCommandIngest')
  })

  it('arms from App without exclusive onboarding and shows ear chip', () => {
    expect(app).toContain('startMetisCommandEar')
    expect(app).toContain("get('exclusiveOnboarding') === '1'")
    expect(app).toContain('data-metis-command-ear-chip')
    expect(app).toContain("openPermissionSettings('microphone')")
  })

  it('main ingests Cap2 from local YOU ASR', () => {
    expect(main).toContain("p.speaker === 'you'")
    expect(main).toContain('ingestMetisCommandFromAsr(text)')
  })
})
