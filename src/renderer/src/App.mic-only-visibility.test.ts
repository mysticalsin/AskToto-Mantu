import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Normalize CRLF → LF (same rationale as App.capture-permission.test.ts): Windows checkouts would
// otherwise break any anchor whose newline sits mid-string.
const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')
const listen = readFileSync(join(__dirname, 'lib', 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')
const bar = readFileSync(join(__dirname, 'components', 'Bar.tsx'), 'utf8').replace(/\r\n/g, '\n')
const pill = readFileSync(join(__dirname, 'components', 'ControlPill.tsx'), 'utf8').replace(/\r\n/g, '\n')
const settingsUi = readFileSync(join(__dirname, 'components', 'Settings.tsx'), 'utf8').replace(/\r\n/g, '\n')

// Tony 2026-07-20: a whole meeting ran with Screen Recording off (15,521 capture.failed audit events).
// The mic-only soft note only rendered inside the Copilot body — invisible with the panel collapsed or
// the widget minimized — while the "Heard live" chip and the pill's red rec-dot claimed all was fine.
// These anchors pin the persistent-chrome visibility that fixed it.
describe('mic-only capture degradation stays visible', () => {
  it('useListen exposes a structured captureDegraded state, permission-classified for the them side', () => {
    expect(listen).toMatch(/export interface CaptureDegraded/)
    expect(listen).toMatch(/captureDegraded: CaptureDegraded \| null/)
    // Set from the start()-time soft note, with the Screen-Recording cause carried as `permission`.
    expect(listen).toMatch(/side: micOk \? 'them' : 'you', note, permission: micOk && isSysPermDenied/)
    // Reset on every fresh start and on final teardown — a stale flag must not leak across sessions.
    expect(listen).toMatch(/error: null, captureDegraded: null, listening: true, paused: false/)
    expect(listen).toMatch(
      /listening: false,\n {12}capturing: false,\n {12}paused: false,\n {12}loading: false,\n {12}error,\n {12}captureDegraded: null/
    )
  })

  it('mid-session recovery of the them channel clears the start-time mic-only note (was left stuck)', () => {
    // recoverSystemAudio used to match only THEM_LOST_MSG on success, so a mid-meeting Screen Recording
    // grant left "System audio needs Screen Recording permission…" showing for the rest of the session.
    const recoverStart = listen.indexOf('recoverSystemAudioRef.current = async')
    const recoverEnd = listen.indexOf('devicechange', recoverStart)
    const recoverBlock = listen.slice(recoverStart, recoverEnd)
    expect(recoverStart).toBeGreaterThan(-1)
    expect(recoverBlock).toMatch(/s\.error === THEM_LOST_MSG \|\| \(s\.captureDegraded\?\.side === 'them' && s\.error === s\.captureDegraded\.note\)/)
    expect(recoverBlock).toMatch(/captureDegraded: s\.captureDegraded\?\.side === 'them' \? null : s\.captureDegraded/)
  })

  it("the Bar's Heard-live chip flips to an honest amber Mic-only/No-mic state while degraded", () => {
    expect(bar).toMatch(/captureDegraded\?: CaptureDegraded \| null/)
    expect(bar).toMatch(/props\.captureDegraded\.side === 'them' \? 'Mic only' : 'No mic'/)
    // The full platform-aware cause rides on the chip as its tooltip.
    expect(bar).toMatch(/title=\{!props\.paused \? props\.captureDegraded\?\.note : undefined\}/)
    expect(app).toMatch(/captureDegraded=\{listen\.captureDegraded\}/)
  })

  it('the minimized circle keeps mood color; degraded truth rides the tooltip, not a red/amber paint', () => {
    expect(pill).toMatch(/degradedNote\?: string \| null/)
    expect(pill).toMatch(/const title = degradedNote \|\| 'Expand Métis'/)
    expect(pill).toMatch(/<ObsidianOrb/)
    expect(pill).toMatch(/title=\{title\}/)
    expect(pill).not.toMatch(/moodFromListen/)
    expect(app).toMatch(/degradedNote=\{listen\.captureDegraded\?\.note \?\? null\}/)
  })

  it('persists a mic-only stretch to Settings once per degraded stretch (asrLastFallbackAt contract)', () => {
    // Ref-guarded like webgpuNotifiedRef: a Dismiss in Settings mid-meeting must not be re-patched by the
    // same still-true state.
    expect(app).toMatch(/const micOnlyNotifiedRef = useRef\(false\)/)
    expect(app).toMatch(/listen\.captureDegraded\?\.side === 'them'/)
    expect(app).toMatch(/void patch\(\{ micOnlyFallbackAt: Date\.now\(\) \}\)/)
  })

  it('Settings → Audio surfaces the trace with a Screen Recording action and a Dismiss', () => {
    expect(settingsUi).toMatch(/settings\.micOnlyFallbackAt != null/)
    expect(settingsUi).toMatch(/captured your microphone only/)
    expect(settingsUi).toMatch(/openPermissionSettings\('screenRecording'\)/)
    expect(settingsUi).toMatch(/patch\(\{ micOnlyFallbackAt: null \}\)/)
  })
})
