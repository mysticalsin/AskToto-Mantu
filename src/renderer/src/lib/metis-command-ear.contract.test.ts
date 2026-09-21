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

  it('arms from App after onboardingDone and shows ear chip', () => {
    expect(app).toContain('startMetisCommandEar')
    expect(app).toContain('settings?.onboardingDone === true')
    expect(app).toContain('data-metis-command-ear-chip')
    expect(app).toContain("openPermissionSettings('microphone')")
  })

  it('main ingests Cap2 from local YOU ASR', () => {
    expect(main).toContain("p.speaker === 'you'")
    expect(main).toContain('ingestMetisCommandFromAsr(text)')
  })

  it('tries every engine per window — one dead engine must not mute the wake path', () => {
    // Tony live FAIL 72c36473: Parakeet's model files were missing, every window rejected, and the ear
    // never fell through to Apple Speech. Both feeds are reached from one cascade now.
    expect(ear).toContain('transcribeWindow')
    expect(ear).toMatch(/order: EngineId\[\] =[\s\S]*'parakeet', 'apple'/)
    expect(ear).toContain('engineDead[via] = true')
    expect(ear).toContain('feedUnavailable')
  })

  it('reports a deaf ear instead of failing silent', () => {
    expect(ear).toContain("reportBroken('asr-engine-missing')")
    expect(ear).toContain("reportBroken('mic-silent')")
    expect(app).toContain('Ear on · no ASR engine')
    expect(app).toContain('Mic silent · check input')
  })

  it('overlaps windows so a wake phrase on a boundary is still whole', () => {
    expect(ear).toContain('HOP_SEC')
    expect(ear).toMatch(/pending = pending\.slice\(Math\.min\(hop/)
  })

  it('main reports an unrunnable engine as unavailable rather than throwing', () => {
    expect(main).toContain('if (!parakeetModelReady()) {')
    expect(main).toContain('if (!appleSpeechAvailable()) {')
    expect(main).toContain("return { text: '', unavailable: true }")
    expect(main).toContain('[cap2] parakeet transcribe failed')
    expect(main).toContain('[cap2] wake engines parakeet=')
  })

  it('asks for the mic grant from main before listening to silence', () => {
    // macOS returns a live track of zeros, not an error, when the TCC grant was never made.
    expect(ear).toContain('cap2EarPrepare')
    expect(main).toContain("systemPreferences.askForMediaAccess('microphone')")
  })

  it('keeps the pill host opaque while the listen orb is up', () => {
    expect(main).toContain('metisCommandPillLive = live')
    expect(main).toMatch(/metisCommandPillLive\s*\?\s*1/)
  })
})

describe('Cap2 Ear stays top-center (Cap4 dock must not steal it)', () => {
  it('CommandListeningPill is fixed top-center, never dock-scoped', () => {
    const pill = readFileSync(join(__dirname, '../components/CommandListeningPill.tsx'), 'utf8')
    expect(pill).toContain('fixed left-1/2 top-3')
    expect(pill).toContain('-translate-x-1/2')
    expect(pill).not.toMatch(/dock-panel|overlay-dock/)
  })

  it('App mounts CommandListeningPill outside the AskSurface swap', () => {
    // Cap4 swaps Bar↔DockPanel for Ask; the Ear pill must remain a sibling, not inside DockPanel.
    expect(app).toContain('<CommandListeningPill')
    // Dock lane types AskSurface as ComponentType<DockPanelProps>; SoT used untyped.
    expect(app).toMatch(/AskSurface[\s\S]*?overlayLayout === 'dock'/)
    const pillIdx = app.indexOf('<CommandListeningPill')
    const dockImportUses = app.indexOf('DockPanel')
    expect(pillIdx).toBeGreaterThan(0)
    // Pill markup is not nested inside DockPanel.tsx
    const dockSrc = readFileSync(join(__dirname, '../components/DockPanel.tsx'), 'utf8')
    expect(dockSrc).not.toContain('CommandListeningPill')
    expect(dockSrc).not.toContain('data-metis-command-ear-chip')
  })

  it('CommandListeningPill stays visible while Island/Dock are parked (not gated on overlayPeeked)', () => {
    // Cap2 wake must surface the pill even when Cap4 park swapped Ask → OverlayPeek.
    expect(app).toMatch(/visible=\{\!onboardingBoot && metisCommand\.pillVisible\}/)
    expect(app).not.toMatch(/visible=\{\!onboardingBoot && \!overlayPeeked && metisCommand\.pillVisible\}/)
    expect(app).toMatch(/commandPill:\s*metisCommand\.pillVisible/)
  })

})
