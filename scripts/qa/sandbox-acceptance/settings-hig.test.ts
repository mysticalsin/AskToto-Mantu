import { describe, expect, it } from 'vitest'
import { createReport, finishReport, runStep } from './lib.mjs'
import {
  CDP_MODIFIERS,
  HIG_SEED_SETTINGS,
  REPLAY,
  SETTINGS_HIG_STEPS,
  buildKeyEvents,
  classifyConfirmObservation,
  classifyEndpointObservation,
  classifyMicObservation,
  dependentOutcome,
  escapeKeyEvents,
  isMicCaptureAuditEvent,
  runSettingsHigScenario,
  settingsShortcutEvents,
  shapeObservation
} from './settings-hig.mjs'
import { customEndpointError } from '../../../src/shared/custom-endpoint'

describe('key event builders', () => {
  it('builds a rawKeyDown/keyUp pair that carries the same key, code and modifiers', () => {
    const [down, up] = buildKeyEvents({ key: 'x', code: 'KeyX', keyCode: 88, modifiers: CDP_MODIFIERS.shift })
    expect(down).toMatchObject({
      type: 'rawKeyDown',
      key: 'x',
      code: 'KeyX',
      windowsVirtualKeyCode: 88,
      nativeVirtualKeyCode: 88,
      modifiers: 8,
      commands: []
    })
    expect(up).toEqual({ ...down, type: 'keyUp' })
  })

  it('uses Command (meta) on macOS and Control on Windows for the Settings chord, chosen by the injected platform', () => {
    const mac = settingsShortcutEvents('darwin')
    const windows = settingsShortcutEvents('win32')
    expect(mac.map((event) => event.type)).toEqual(['rawKeyDown', 'keyUp'])
    expect(mac[0]).toMatchObject({ key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: CDP_MODIFIERS.meta })
    expect(windows[0]).toMatchObject({ key: ',', code: 'Comma', modifiers: CDP_MODIFIERS.ctrl })
    expect(settingsShortcutEvents('linux')[0].modifiers).toBe(CDP_MODIFIERS.meta)
    // Never also Shift or Alt: the app's own isSettingsShortcut refuses them.
    for (const event of [...mac, ...windows])
      expect(event.modifiers & (CDP_MODIFIERS.shift | CDP_MODIFIERS.alt)).toBe(0)
  })

  it('builds Escape with no modifier', () => {
    expect(escapeKeyEvents()[0]).toMatchObject({
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      modifiers: 0
    })
  })
})

describe('step result shaping', () => {
  it('returns the evidence when there is no problem and throws every problem otherwise', () => {
    expect(shapeObservation({ problems: [], evidence: { ok: true } })).toEqual({ evidence: { ok: true } })
    expect(() => shapeObservation({ problems: ['a', 'b'], evidence: { n: 1 } })).toThrow(/a; b \(observed \{"n":1\}\)/)
  })

  it('maps a dependent step onto PASS (run), NOT_SUPPORTED (inherited) or SKIPPED', () => {
    const steps = [
      { id: 'ok', status: 'PASS' },
      { id: 'gap', status: 'NOT_SUPPORTED', reason: 'no such surface' },
      { id: 'bad', status: 'FAIL', reason: 'broken' }
    ]
    expect(dependentOutcome(steps, 'ok')).toBeNull()
    expect(dependentOutcome(steps, 'gap')).toMatchObject({
      status: 'NOT_SUPPORTED',
      reason: expect.stringContaining('no such surface')
    })
    expect(dependentOutcome(steps, 'bad')).toMatchObject({ status: 'SKIPPED' })
    expect(dependentOutcome(steps, 'missing')).toMatchObject({ status: 'SKIPPED' })
  })
})

describe('classifyMicObservation', () => {
  const base = { getUserMediaCalls: 0, micAuditEvents: [], testButtonVisible: false, openSettingsVisible: false }
  it('passes an undetermined microphone that shows Test Microphone and made no request', () => {
    expect(classifyMicObservation({ ...base, status: 'unknown', testButtonVisible: true })).toEqual({
      supported: true,
      problems: []
    })
  })
  it('passes a denied microphone that offers the System Settings link and no Test Microphone', () => {
    expect(classifyMicObservation({ ...base, status: 'denied', openSettingsVisible: true }).problems).toEqual([])
  })
  it('fails on a getUserMedia call, a mic audit record or a missing control', () => {
    const request = classifyMicObservation({
      ...base,
      status: 'unknown',
      testButtonVisible: true,
      getUserMediaCalls: 1,
      micAuditEvents: ['listen.start']
    })
    expect(request.problems).toHaveLength(2)
    expect(classifyMicObservation({ ...base, status: 'unknown' }).problems).toEqual([
      '"Test Microphone" is not visible'
    ])
    expect(classifyMicObservation({ ...base, status: 'denied', testButtonVisible: true }).problems).toHaveLength(2)
  })
  it('reports NOT_SUPPORTED for a granted microphone and fails on an unreadable status', () => {
    expect(classifyMicObservation({ ...base, status: 'granted' })).toMatchObject({ supported: false })
    expect(classifyMicObservation({ ...base, status: 'not-required' })).toMatchObject({ supported: false })
    expect(classifyMicObservation({ ...base, status: null, testButtonVisible: true }).problems[0]).toMatch(
      /reported microphone null/
    )
  })
})

describe('isMicCaptureAuditEvent', () => {
  it('recognises capture-start families and ignores boot and screen records', () => {
    for (const event of ['listen.start', 'mic.capture.start', 'meeting.start', 'capture.mic.start'])
      expect(isMicCaptureAuditEvent(event)).toBe(true)
    for (const event of [
      'qa.capture.file_source',
      'app.renderer.ready',
      'capture.screen',
      'capture.check',
      'settings.changed',
      undefined
    ])
      expect(isMicCaptureAuditEvent(event)).toBe(false)
  })
})

describe('classifyEndpointObservation', () => {
  const good = {
    describedBy: ':r1:',
    alertId: ':r1:',
    alertRole: 'alert',
    alertText: 'Use an address that starts with https://.',
    ariaInvalid: 'true',
    blockingAlertDialogs: 0,
    baseline: 'https://a.invalid/v1',
    stored: 'https://a.invalid/v1'
  }
  it('accepts a linked role=alert error with an unchanged stored value', () => {
    expect(classifyEndpointObservation(good)).toEqual([])
  })
  it('rejects each way the inline validation can be wrong', () => {
    expect(classifyEndpointObservation({ ...good, describedBy: null })).toHaveLength(1)
    expect(classifyEndpointObservation({ ...good, alertId: 'other' })[0]).toMatch(/does not point/)
    expect(classifyEndpointObservation({ ...good, alertRole: 'status' })[0]).toMatch(/role "status"/)
    expect(classifyEndpointObservation({ ...good, alertText: '  ' })[0]).toMatch(/empty/)
    expect(classifyEndpointObservation({ ...good, ariaInvalid: null })[0]).toMatch(/aria-invalid/)
    expect(classifyEndpointObservation({ ...good, blockingAlertDialogs: 1 })[0]).toMatch(/blocking/)
    expect(classifyEndpointObservation({ ...good, stored: 'http://x.invalid' })[0]).toMatch(/changed/)
  })
  it('uses a seed the app itself accepts and an insecure value the app itself refuses', async () => {
    expect(customEndpointError(HIG_SEED_SETTINGS.customBaseUrl, { required: true })).toBeNull()
    const { INSECURE_ENDPOINT } = await import('./settings-hig.mjs')
    expect(customEndpointError(INSECURE_ENDPOINT, { required: true })).not.toBeNull()
  })
})

describe('classifyConfirmObservation', () => {
  const good = {
    role: 'alertdialog',
    title: REPLAY.title,
    buttons: ['Cancel', REPLAY.confirm],
    focusedLabel: REPLAY.confirm,
    closedAfterEscape: true,
    settingsStillOpen: true,
    onboardingDoneBefore: true,
    onboardingDoneAfter: true
  }
  it('accepts the default-focused sheet that Escape cancels without changing state', () => {
    expect(classifyConfirmObservation(good)).toEqual([])
  })
  it('flags wrong focus, a sheet that stays open, a closed Settings and changed state', () => {
    expect(classifyConfirmObservation({ ...good, focusedLabel: 'Cancel' })[0]).toMatch(/focus is on "Cancel"/)
    expect(classifyConfirmObservation({ ...good, closedAfterEscape: false })).toEqual([
      'Escape did not close the sheet'
    ])
    expect(classifyConfirmObservation({ ...good, settingsStillOpen: false })).toEqual(['Escape also closed Settings'])
    expect(classifyConfirmObservation({ ...good, onboardingDoneAfter: false })[0]).toMatch(/Cancel must change nothing/)
    expect(classifyConfirmObservation({ ...good, buttons: [REPLAY.confirm, 'Cancel'] })[0]).toMatch(/sheet buttons/)
  })
})

describe('runSettingsHigScenario', () => {
  it('records exactly the planned steps in order, and a launch failure skips every dependent step without a PASS', async () => {
    const report = createReport({ tool: 'test' })
    await runSettingsHigScenario({
      report,
      launch: () => Promise.reject(new Error('could not launch')),
      onSession: () => {},
      platform: 'darwin'
    })
    expect(report.steps.map((step) => step.id)).toEqual([...SETTINGS_HIG_STEPS])
    expect(report.steps[0]).toMatchObject({ status: 'FAIL', reason: 'could not launch' })
    expect(report.steps.slice(1).every((step) => step.status === 'SKIPPED')).toBe(true)
    expect(finishReport(report).verdict).toBe('FAIL')
  })

  it('still lets runStep refuse a PASS without evidence', async () => {
    const report = createReport({ tool: 'test' })
    const step = await runStep(report, 's', async () => ({}))
    expect(step.status).toBe('FAIL')
  })
})
