import { describe, expect, it } from 'vitest'
import type { ScreenDiagnosis } from '@shared/screen-permission'
import { SCREEN_REPAIR_MANUAL_GUIDANCE } from '@shared/screen-capture'
import { listenScreenNote, screenGrantHolder, screenPermissionCopy, withDiagnosedThemNote } from './screen-permission-copy'

const base: ScreenDiagnosis = {
  state: 'denied',
  reasons: [],
  action: 'open-settings',
  duplicates: [],
  grantedFor: null,
  repairFailed: false
}
const diag = (patch: Partial<ScreenDiagnosis>): ScreenDiagnosis => ({ ...base, ...patch })

describe('screenPermissionCopy (M2-0429)', () => {
  it('says nothing when capture works or there is no diagnosis', () => {
    expect(screenPermissionCopy(diag({ state: 'granted', action: 'none' }))).toBeNull()
    expect(screenPermissionCopy(undefined)).toBeNull()
  })

  it('not-effective never offers Open Settings as its only action: it offers Repair and names the holder', () => {
    const copy = screenPermissionCopy(
      diag({ state: 'not-effective', action: 'repair', reasons: ['identity-changed'], grantedFor: { version: '1.9.6', cdhash: 'b'.repeat(40) } })
    )
    expect(copy).toMatchObject({ repair: true, openSettings: false })
    expect(copy?.text).toContain('Métis 1.9.6')
    expect(copy?.text).toContain('Repair resets only Métis’s Screen Recording entry')
  })

  it('names the duplicate copy that may hold the grant', () => {
    const one = diag({
      state: 'not-effective',
      action: 'repair',
      reasons: ['duplicate-bundles'],
      duplicates: [{ path: '/Users/someone/Applications/Metis.app', version: '1.5.4' }]
    })
    expect(screenGrantHolder(one)).toBe('another copy of Métis (/Users/someone/Applications/Metis.app)')
    const three = diag({ ...one, duplicates: [...one.duplicates, ...one.duplicates, ...one.duplicates] })
    expect(screenGrantHolder(three)).toBe('one of 3 other copies of Métis')
  })

  it('after a failed Repair, guides remove with minus then add with plus', () => {
    const copy = screenPermissionCopy(diag({ state: 'not-effective', action: 'open-settings', reasons: ['attested-then-relaunched'], repairFailed: true }))
    expect(copy).toMatchObject({ repair: false, openSettings: true })
    expect(copy?.text).toContain(SCREEN_REPAIR_MANUAL_GUIDANCE)
  })

  it('translocated asks for a move to Applications, not a Settings trip', () => {
    const copy = screenPermissionCopy(diag({ state: 'not-effective', action: 'move-to-applications', reasons: ['translocated'] }))
    expect(copy).toMatchObject({ repair: false, openSettings: false })
    expect(copy?.text).toMatch(/Move Métis to Applications/)
  })

  it('denied offers the pane and the "It\'s already on" path; needs-relaunch offers a restart', () => {
    expect(screenPermissionCopy(diag({}))).toMatchObject({ openSettings: true, attest: true, repair: false })
    expect(screenPermissionCopy(diag({ state: 'needs-relaunch', action: 'relaunch' }))).toMatchObject({ relaunch: true })
  })

  it('restricted offers no action a user cannot take', () => {
    expect(screenPermissionCopy(diag({ state: 'restricted', action: 'none' }))).toMatchObject({
      repair: false,
      attest: false,
      openSettings: false,
      relaunch: false
    })
  })
})

describe('listenScreenNote', () => {
  it('the mic-only note says the other side is missing and carries the diagnosis and Repair flag', () => {
    const note = listenScreenNote(
      diag({ state: 'not-effective', action: 'repair', reasons: ['identity-changed'], grantedFor: { version: '1.9.6', cdhash: 'b'.repeat(40) } }),
      true
    )
    expect(note?.repair).toBe(true)
    expect(note?.note).toMatch(/^Listening to your microphone only/)
    expect(note?.note).toContain('belongs to Métis 1.9.6')
  })

  it('is null when there is nothing to say', () => {
    expect(listenScreenNote(diag({ state: 'granted', action: 'none' }), true)).toBeNull()
  })
})

describe('withDiagnosedThemNote — the Listen note and Bar chip follow the diagnosis', () => {
  const START_NOTE = 'System audio needs Screen Recording permission. Listening to microphone only.'
  const notEffective = diag({
    state: 'not-effective',
    action: 'repair',
    reasons: ['identity-changed'],
    grantedFor: { version: '1.9.6', cdhash: 'b'.repeat(40) }
  })
  const micOnly = () => ({
    error: START_NOTE as string | null,
    captureDegraded: { side: 'them' as const, note: START_NOTE, permission: true },
    listening: true
  })

  it('replaces the start-time mic-only note with one naming the holder, flags Repair, and keeps the error in step', () => {
    const themRef = { current: null as ReturnType<typeof micOnly>['captureDegraded'] | null }
    const next = withDiagnosedThemNote(micOnly(), notEffective, themRef)
    expect(next.captureDegraded?.note).toContain('belongs to Métis 1.9.6')
    expect(next.captureDegraded).toMatchObject({ side: 'them', permission: true, repair: true })
    expect(next.error).toBe(next.captureDegraded?.note)
    expect(next.listening).toBe(true)
    expect(themRef.current).toEqual(next.captureDegraded)
  })

  it('returns the same state object when nothing would change, so a repeating poll never re-renders', () => {
    const themRef = { current: null }
    const once = withDiagnosedThemNote(micOnly(), notEffective, themRef)
    expect(withDiagnosedThemNote(once, notEffective, themRef)).toBe(once)
    const s = micOnly()
    expect(withDiagnosedThemNote(s, diag({ state: 'granted', action: 'none' }), themRef)).toBe(s)
    expect(withDiagnosedThemNote(s, undefined, themRef)).toBe(s)
  })

  it('never touches a missing-microphone note or an unrelated error', () => {
    const themRef = { current: null }
    const noMic = { error: 'Microphone unavailable.', captureDegraded: { side: 'you' as const, note: 'Microphone unavailable.', permission: false } }
    expect(withDiagnosedThemNote(noMic, notEffective, themRef)).toBe(noMic)
    const other = { ...micOnly(), error: 'Transcription fell behind.' }
    expect(withDiagnosedThemNote(other, notEffective, themRef).error).toBe('Transcription fell behind.')
  })
})
