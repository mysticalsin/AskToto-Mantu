import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { createCommandPreflight, type CommandPreflightDeps } from './command-preflight'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Groceries' } }
const PHOTO: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }
const ARC: DesktopActionRequest = { id: 'desktop.open_arc', args: {} }
const SEARCH: DesktopActionRequest = { id: 'desktop.google_search', args: { q: 'metis' } }

function make(overrides: Partial<CommandPreflightDeps> = {}) {
  const deps: CommandPreflightDeps = {
    platform: 'darwin',
    isAuthenticated: () => true,
    isRecordingMeeting: () => false,
    appInstalled: vi.fn(async () => true),
    automationStatus: vi.fn(async () => 'granted' as const),
    accessibilityTrusted: () => true,
    ...overrides
  }
  return { deps, preflight: createCommandPreflight(deps) }
}

describe('command preflight: honest copy instead of a card that cannot succeed', () => {
  it('passes when everything is in place', async () => {
    expect(await make().preflight(NOTE, 'propose')).toEqual({ ok: true })
    expect(await make().preflight(NOTE, 'confirm')).toEqual({ ok: true })
  })

  it('refuses when signed out, with the sign-in copy', async () => {
    const { preflight } = make({ isAuthenticated: () => false })
    expect(await preflight(NOTE, 'propose')).toEqual({
      ok: false,
      notice: { code: 'signed_out', copy: 'Sign in to Métis to use voice actions.' }
    })
  })

  it('refuses a new card while a meeting is being recorded, but does not retract a card already on screen', async () => {
    const { preflight } = make({ isRecordingMeeting: () => true })
    expect(await preflight(NOTE, 'propose')).toEqual({
      ok: false,
      notice: { code: 'meeting_recording', copy: 'Voice actions are paused while Métis records a meeting.' }
    })
    expect(await preflight(NOTE, 'confirm')).toEqual({ ok: true })
  })

  it('names the missing target app and promises no substitute', async () => {
    const { preflight, deps } = make({ appInstalled: vi.fn(async () => false) })
    expect(await preflight(ARC, 'propose')).toEqual({
      ok: false,
      notice: { code: 'app_missing', copy: "Arc isn't installed. Métis won't use another browser instead." }
    })
    expect(deps.appInstalled).toHaveBeenCalledWith('company.thebrowser.Browser')
  })

  it('proceeds when installation cannot be determined (no helper), leaving the adapter to fail visibly', async () => {
    const { preflight } = make({ appInstalled: async () => null })
    expect(await preflight(ARC, 'propose')).toEqual({ ok: true })
  })

  it('refuses when Automation to Notes is denied, and links the Automation pane', async () => {
    const { preflight, deps } = make({ automationStatus: vi.fn(async () => 'denied' as const) })
    expect(await preflight(NOTE, 'propose')).toEqual({
      ok: false,
      notice: {
        code: 'automation_denied',
        copy: "Métis isn't allowed to control Notes.",
        settingsKind: 'automation'
      }
    })
    expect(deps.automationStatus).toHaveBeenCalledWith('com.apple.Notes', { ask: false })
  })

  it('asks for Automation only at confirm time, before dispatch, never while merely proposing', async () => {
    const status = vi.fn(async (_bundleId: string, options: { ask: boolean }) =>
      options.ask ? ('granted' as const) : ('unknown' as const)
    )
    const { preflight } = make({ automationStatus: status })
    expect(await preflight(NOTE, 'propose')).toEqual({ ok: true })
    expect(status).toHaveBeenLastCalledWith('com.apple.Notes', { ask: false })
    expect(await preflight(NOTE, 'confirm')).toEqual({ ok: true })
    expect(status).toHaveBeenLastCalledWith('com.apple.Notes', { ask: true })
  })

  it('needs Accessibility and System Events for the Photo Booth shutter', async () => {
    const noAx = make({ accessibilityTrusted: () => false })
    expect(await noAx.preflight(PHOTO, 'propose')).toEqual({
      ok: false,
      notice: {
        code: 'accessibility_needed',
        copy: 'To press the shutter in Photo Booth, Métis needs Accessibility.',
        settingsKind: 'accessibility'
      }
    })
    const events = make({ automationStatus: vi.fn(async () => 'denied' as const) })
    expect(await events.preflight(PHOTO, 'propose')).toMatchObject({
      ok: false,
      notice: { code: 'automation_denied', settingsKind: 'automation' }
    })
    expect(events.deps.automationStatus).toHaveBeenCalledWith('com.apple.systemevents', { ask: false })
  })

  it('does not ask for any macOS permission for a search or on Windows', async () => {
    const mac = make()
    expect(await mac.preflight(SEARCH, 'confirm')).toEqual({ ok: true })
    expect(mac.deps.automationStatus).not.toHaveBeenCalled()
    const win = make({ platform: 'win32' })
    expect(await win.preflight(NOTE, 'confirm')).toEqual({ ok: true })
    expect(await win.preflight(PHOTO, 'confirm')).toEqual({ ok: true })
    expect(win.deps.automationStatus).not.toHaveBeenCalled()
  })

  it('checks sign-in before anything that touches the OS', async () => {
    const { preflight, deps } = make({ isAuthenticated: () => false })
    await preflight(NOTE, 'confirm')
    expect(deps.automationStatus).not.toHaveBeenCalled()
    expect(deps.appInstalled).not.toHaveBeenCalled()
  })
})
