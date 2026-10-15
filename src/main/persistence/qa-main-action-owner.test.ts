import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({
  authCurrent: true,
  settingsReadable: true,
  receiptCurrent: true,
  authReads: 0,
  settingsReads: 0,
  receiptReads: 0
}))

vi.mock('electron', () => ({ app: { isPackaged: true, getName: () => 'asktoto-qa' } }))
vi.mock('../qa-identity', () => ({ QA_IDENTITY_BUILD: true }))
vi.mock('../auth', () => ({
  capturePublishedMainPersistenceSessionBoundary: () => {
    authority.authReads += 1
    return authority.authCurrent ? { isCurrent: () => authority.authCurrent } : null
  }
}))
vi.mock('../settings-observation', () => ({
  getPublishedSettingsObservation: () => {
    authority.settingsReads += 1
    return authority.settingsReadable ? { readable: true, settings: {} } : null
  }
}))
vi.mock('../settings-authority-history', () => ({
  captureSettingsAuthority: () => {
    authority.receiptReads += 1
    return authority.receiptCurrent ? Object.freeze({}) : null
  },
  isSettingsAuthorityCurrent: () => authority.receiptCurrent
}))
import {
  assertQaPersistenceRunWindowCurrent,
  bindQaPersistenceMainWindow,
  captureQaPersistenceAction,
  captureQaPersistenceRunWindowProof,
  qaPersistenceRunWindowRetirementSignal
} from './qa-main-action-owner'

class SyntheticContents extends EventEmitter {
  destroyed = false
  url = pathToFileURL(join(__dirname, '../renderer/index.html')).href
  mainFrame = { processId: 23, routingId: 31, parent: null }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
}

class SyntheticBrowserWindow extends EventEmitter {
  destroyed = false
  visible = false
  webContents = new SyntheticContents()
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
}

function fixture() {
  const window = new SyntheticBrowserWindow()
  bindQaPersistenceMainWindow(window as never)
  window.emit('show')
  window.visible = true
  window.webContents.emit('did-navigate', {}, window.webContents.url, 200, 'OK')
  const event = (overrides: Record<string, unknown> = {}) =>
    ({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
      ...overrides
    }) as never
  return { window, event }
}

describe('QA main action window owner', () => {
  beforeEach(() => {
    authority.authCurrent = true
    authority.settingsReadable = true
    authority.receiptCurrent = true
    authority.authReads = 0
    authority.settingsReads = 0
    authority.receiptReads = 0
  })

  it('requires first show, the current visible window, and a settled packaged renderer', () => {
    const hidden = new SyntheticBrowserWindow()
    bindQaPersistenceMainWindow(hidden as never)
    expect(captureQaPersistenceAction({} as never, 'status-no-side-effects')).toEqual({
      state: 'refused',
      reason: 'window-not-shown'
    })

    const { window, event } = fixture()
    window.visible = false
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('window-hidden')
    window.visible = true
    window.webContents.url = 'http://localhost:5173/'
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('renderer-not-trusted')
  })

  it('requires the exact sender and current top frame, then refuses without a C2 run owner', () => {
    const { window, event } = fixture()
    expect(captureQaPersistenceAction(event(), 'not-a-case' as never).reason).toBe('invalid-case')
    expect(
      captureQaPersistenceAction(event({ sender: new SyntheticContents() }), 'status-no-side-effects').reason
    ).toBe('sender-mismatch')
    expect(
      captureQaPersistenceAction(
        event({ senderFrame: { processId: 23, routingId: 32, parent: window.webContents.mainFrame } }),
        'status-no-side-effects'
      ).reason
    ).toBe('frame-mismatch')
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('run-unavailable')
  })

  it('does not accept a replacement frame with reused process and routing identifiers', () => {
    const { window, event } = fixture()
    window.webContents.mainFrame = { processId: 23, routingId: 31, parent: null }
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('frame-mismatch')
  })

  it('captures an opaque committed main document proof and keeps it current while the window is hidden', () => {
    const { window } = fixture()
    const proof = captureQaPersistenceRunWindowProof()
    expect(proof).not.toBeNull()
    if (!proof) throw new Error('Expected a positive QA main-window proof')
    const signal = qaPersistenceRunWindowRetirementSignal(proof)
    expect(signal.aborted).toBe(false)
    window.visible = false
    expect(() => assertQaPersistenceRunWindowCurrent(proof)).not.toThrow()
    expect(signal.aborted).toBe(false)
  })

  it('issues the proof after the constructor document completes its first navigation', () => {
    const window = new SyntheticBrowserWindow()
    bindQaPersistenceMainWindow(window as never)
    window.emit('show')
    window.visible = true
    expect(captureQaPersistenceRunWindowProof()).toBeNull()
    window.webContents.emit('did-start-navigation', {}, window.webContents.url, false, true)
    window.webContents.emit('did-navigate', {}, window.webContents.url, 200, 'OK')
    const proof = captureQaPersistenceRunWindowProof()
    expect(proof).not.toBeNull()
    if (proof) expect(() => assertQaPersistenceRunWindowCurrent(proof)).not.toThrow()
  })

  it('permanently retires the captured document on A to B to A top-frame navigation', () => {
    const { window } = fixture()
    const proof = captureQaPersistenceRunWindowProof()
    expect(proof).not.toBeNull()
    if (!proof) throw new Error('Expected a positive QA main-window proof')
    const signal = qaPersistenceRunWindowRetirementSignal(proof)
    window.webContents.emit('did-start-navigation', {}, 'file:///outside.html', false, true)
    expect(signal.aborted).toBe(true)
    window.webContents.url = 'file:///outside.html'
    window.webContents.emit('did-navigate', {}, window.webContents.url, 200, 'OK')
    window.webContents.emit('did-start-navigation', {}, window.webContents.url, false, true)
    window.webContents.mainFrame = { processId: 23, routingId: 31, parent: null }
    window.webContents.url = pathToFileURL(join(__dirname, '../renderer/index.html')).href
    window.webContents.emit('did-navigate', {}, window.webContents.url, 200, 'OK')
    expect(() => assertQaPersistenceRunWindowCurrent(proof)).toThrow()
    expect(captureQaPersistenceRunWindowProof()).not.toBeNull()
  })

  it('retires on window replacement and render-process loss', () => {
    const first = fixture()
    const oldProof = captureQaPersistenceRunWindowProof()
    expect(oldProof).not.toBeNull()
    if (!oldProof) throw new Error('Expected a positive QA main-window proof')
    const oldSignal = qaPersistenceRunWindowRetirementSignal(oldProof)
    const replacement = fixture()
    expect(oldSignal.aborted).toBe(true)
    expect(() => assertQaPersistenceRunWindowCurrent(oldProof)).toThrow()

    const nextProof = captureQaPersistenceRunWindowProof()
    expect(nextProof).not.toBeNull()
    if (!nextProof) throw new Error('Expected a replacement QA main-window proof')
    const nextSignal = qaPersistenceRunWindowRetirementSignal(nextProof)
    replacement.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(nextSignal.aborted).toBe(true)
    expect(() => assertQaPersistenceRunWindowCurrent(nextProof)).toThrow()
    first.window.emit('closed')
  })

  it('retires old document frames across A to B to A navigation and replacement windows', () => {
    const first = fixture()
    const oldFrame = first.window.webContents.mainFrame
    first.window.webContents.emit('did-start-navigation', {}, 'file:///outside.html', false, true)
    first.window.webContents.url = 'file:///outside.html'
    first.window.webContents.emit('did-navigate', {}, first.window.webContents.url, 200, 'OK')
    first.window.webContents.emit('did-start-navigation', {}, first.window.webContents.url, false, true)
    first.window.webContents.mainFrame = { processId: 24, routingId: 33, parent: null }
    first.window.webContents.url = pathToFileURL(join(__dirname, '../renderer/index.html')).href
    first.window.webContents.emit('did-navigate', {}, first.window.webContents.url, 200, 'OK')
    expect(captureQaPersistenceAction(first.event({ senderFrame: oldFrame }), 'status-no-side-effects').reason).toBe(
      'frame-mismatch'
    )

    const replacement = fixture()
    first.window.emit('closed')
    expect(captureQaPersistenceAction(replacement.event(), 'status-no-side-effects').reason).toBe('run-unavailable')
  })

  it('retires on render-process loss, auth change, unreadable settings, and native-key opt-out', () => {
    const { window, event } = fixture()
    authority.authCurrent = false
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('auth-unavailable')
    authority.authCurrent = true
    authority.settingsReadable = false
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('settings-unavailable')
    authority.settingsReadable = true
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(captureQaPersistenceAction(event(), 'status-no-side-effects').reason).toBe('navigation-pending')
  })

  it('refuses original native opt-out before reading auth, settings, or settings receipts', async () => {
    const original = process.env.ASKTOTO_LOCAL_KEYSTORE
    process.env.ASKTOTO_LOCAL_KEYSTORE = 'native'
    try {
      vi.resetModules()
      const owner = await import('./qa-main-action-owner')
      const window = new SyntheticBrowserWindow()
      owner.bindQaPersistenceMainWindow(window as never)
      window.emit('show')
      window.visible = true
      window.webContents.emit('did-navigate', {}, window.webContents.url, 200, 'OK')
      const result = owner.captureQaPersistenceAction(
        {
          sender: window.webContents,
          senderFrame: window.webContents.mainFrame
        } as never,
        'native-journal-create-append'
      )
      expect(result).toEqual({ state: 'refused', reason: 'native-key-opted-out' })
      expect(authority.authReads).toBe(0)
      expect(authority.settingsReads).toBe(0)
      expect(authority.receiptReads).toBe(0)
    } finally {
      if (original === undefined) delete process.env.ASKTOTO_LOCAL_KEYSTORE
      else process.env.ASKTOTO_LOCAL_KEYSTORE = original
      vi.resetModules()
    }
  })
})
