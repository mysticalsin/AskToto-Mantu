import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Tony/Ultron P0 2026-09-21 (VOICE-FIX-BRIEF-0109):
 * Sync DockPanel / CommandListeningPill / metis-command-ear / OnboardingAppearance
 * on the Act1 first-paint path causes forever Loading / black screen.
 */
describe('Act1 lazy-split — no sync poison on first paint', () => {
  const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
  const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')

  it('App keeps OnboardingV2 sync (FITO-185-J) but lazy DockPanel + Pill', () => {
    expect(app).toMatch(/import \{ OnboardingV2 \} from '\.\/components\/OnboardingExperience'/)
    expect(app).toMatch(/const DockPanel = lazy\(/)
    expect(app).toMatch(/const CommandListeningPill = lazy\(/)
    expect(app).not.toMatch(/import \{ DockPanel/)
    expect(app).not.toMatch(/import \{ CommandListeningPill \}/)
  })

  it('App loads the command ear only after onboard via dynamic import', () => {
    expect(app).toMatch(/void import\('\.\/lib\/metis-command-ear'\)/)
    expect(app).not.toMatch(/import \{ startMetisCommandEar/)
  })

  it('OnboardingExperience lazy-loads Appearance (Act4) off Act1 parse', () => {
    expect(experience).toMatch(/const OnboardingAppearance = lazy\(/)
    expect(experience).not.toMatch(/import \{ OnboardingAppearance \} from/)
  })
})
