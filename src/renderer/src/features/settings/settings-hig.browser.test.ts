/**
 * Settings HIG behaviour in a real Chromium DOM (C25): irreversible actions ask first and Cancel changes nothing,
 * a shorter retention window states how many meetings it deletes, inline validation sits next to its field, and
 * OS-dependent toggles show what the OS allows with a way to fix it.
 *
 * Each case mounts one real Settings section beside the real ConfirmSheet host, with window.toto stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0settings-hig-harness'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ConfirmSheet } from ${modulePath('ui/ConfirmSheet.tsx')}
import { NavigationGuardService } from ${modulePath('lib/navigation-guard.ts')}
import { CalendarTab } from ${modulePath('features/settings/CalendarTab.tsx')}
import { DangerZoneSection } from ${modulePath('features/settings/DangerZoneSection.tsx')}
import { MeetingsTab } from ${modulePath('features/settings/MeetingsTab.tsx')}
import { CustomEndpointField } from ${modulePath('features/settings/CustomEndpointField.tsx')}
import { ScreenPermissionRow } from ${modulePath('components/ScreenPermissionRow.tsx')}

const config = window.__higConfig
const calls = []
const record = (name, value) => (...args) => {
  calls.push({ name, args })
  return Promise.resolve(typeof value === 'function' ? value(...args) : value)
}
const base = {
  authStatus: { configured: true, signedIn: true, email: 'person@example.invalid', domain: 'example.invalid' },
  settingsOsState: config.osState ?? { loginItem: { supported: true, enabled: false, requiresApproval: false }, notifications: { supported: true } },
  retentionPreview: config.retentionPreview ?? { ok: true, expired: 0 },
  pickFolder: config.pickFolder ?? { ok: false, reason: 'cancelled' },
  repairScreenPermission: { ok: false, reason: 'tccutil-failed', exitCode: 1, guidance: 'Remove Métis, then add it again.' },
  preservedBrainIndexesList: { copies: [] },
  calendarToday: { ok: true, events: [] },
  openMeetingsFolder: ''
}
window.toto = new Proxy({}, {
  get: (target, key) => {
    if (typeof key !== 'string') return undefined
    if (!(key in target)) target[key] = record(key, key in base ? base[key] : undefined)
    return target[key]
  }
})

const guard = new NavigationGuardService()
let settings = { ...config.settings }
const patches = []
const patch = (next) => {
  patches.push(next)
  if (!config.refusePatch) settings = { ...settings, ...next }
  rerender()
  return Promise.resolve(settings)
}

function Host() {
  const [request, setRequest] = useState(guard.current())
  useEffect(() => guard.subscribe(() => setRequest(guard.current())), [])
  let section = null
  if (config.section === 'calendar') section = createElement(CalendarTab, { settings, patch })
  if (config.section === 'danger') section = createElement(DangerZoneSection, { settings, patch })
  if (config.section === 'meetings') section = createElement(MeetingsTab, { settings, patch })
  if (config.section === 'endpoint') section = createElement(CustomEndpointField, { value: settings.customBaseUrl, required: true, disabled: false, patch })
  if (config.section === 'screen') section = createElement(ScreenPermissionRow, { status: 'granted', diagnosis: config.diagnosis, restarting: false, onRestart: () => {} })
  return createElement('div', { style: { position: 'relative', width: 640, minHeight: 480 } },
    section,
    createElement(ConfirmSheet, { guard, request })
  )
}

const root = createRoot(document.getElementById('root'))
const rerender = () => flushSync(() => root.render(createElement(Host)))
rerender()
window.__hig = { inspect: () => ({ calls: calls.map((c) => c.name), callArgs: calls, patches, settings }) }
`

async function bundleHarness(): Promise<string> {
  const rendererRoot = resolve(rendererSrc, '..')
  const output = (await build({
    root: rendererRoot,
    configFile: false,
    logLevel: 'silent',
    define: { __METIS_FEEDBACK_EMAIL__: '""', __METIS_QA_IDENTITY__: 'false' },
    resolve: { alias: { '@': rendererSrc, '@shared': resolve(rendererRoot, '../shared') } },
    plugins: [
      react(),
      {
        name: 'settings-hig-harness',
        enforce: 'pre',
        resolveId: (id: string) => (id === HARNESS_ID ? id : null),
        load: (id: string) => (id === HARNESS_ID ? HARNESS : null)
      }
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: { input: HARNESS_ID, output: { format: 'iife', inlineDynamicImports: true } }
    }
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

type Inspect = {
  calls: string[]
  callArgs: { name: string; args: unknown[] }[]
  patches: Record<string, unknown>[]
  settings: Record<string, unknown>
}

declare global {
  interface Window {
    __higConfig: Record<string, unknown>
    __hig: { inspect(): Inspect }
  }
}

const SETTINGS = {
  managedKeys: [],
  transcriptRetentionDays: 0,
  resolvedMeetingsFolder: '/sandbox/Meetings',
  teamTranscriptFolders: [],
  encryptTranscripts: true,
  launchAtLogin: false,
  loginItemOpenAtLogin: false,
  meetingNotifications: true,
  azureClientId: '',
  azureTenantId: '',
  azureAllowedDomain: '',
  customBaseUrl: 'https://valid.example.invalid/v1'
}

describe('Settings HIG behaviour (C25)', () => {
  let browser: Browser
  let page: Page
  let bundle: string

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  beforeEach(async () => {
    page = await browser.newPage()
  })

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  async function mount(config: Record<string, unknown>): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate((value) => {
      window.__higConfig = value
    }, config)
    await page.addScriptTag({ content: bundle })
  }
  const inspect = (): Promise<Inspect> => page.evaluate(() => window.__hig.inspect())

  it('Outlook Sign out asks first: Escape cancels without signing out, Sign Out signs out', async () => {
    await mount({ section: 'calendar', settings: SETTINGS })
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true })
    await signOut.click()
    const sheet = page.getByRole('alertdialog', { name: 'Sign out of your Microsoft account?' })
    await sheet.waitFor()
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    expect((await inspect()).calls).not.toContain('signOut')
    await signOut.click()
    await sheet.getByRole('button', { name: 'Sign Out' }).click()
    await expect.poll(async () => (await inspect()).calls).toContain('signOut')
  })

  it('shortening retention states the count and Cancel keeps the current window', async () => {
    await mount({ section: 'danger', settings: SETTINGS, retentionPreview: { ok: true, expired: 12 } })
    const select = page.getByLabel('Auto-delete meetings older than')
    await select.selectOption('30')
    const sheet = page.getByRole('alertdialog', { name: 'Delete 12 older meetings?' })
    await sheet.waitFor()
    expect(await sheet.textContent()).toContain('12 saved meetings are older than 30 days')
    // Destructive consequence: Cancel is focused, so Return cancels.
    await page.keyboard.press('Enter')
    await sheet.waitFor({ state: 'detached' })
    expect((await inspect()).patches).toEqual([])
    expect(await select.inputValue()).toBe('0')
    await select.selectOption('30')
    await sheet.getByRole('button', { name: 'Delete Meetings' }).click()
    await expect.poll(async () => (await inspect()).patches).toEqual([{ transcriptRetentionDays: 30 }])
  })

  it('lengthening retention, or a window that deletes nothing, never asks', async () => {
    await mount({
      section: 'danger',
      settings: { ...SETTINGS, transcriptRetentionDays: 30 },
      retentionPreview: { ok: true, expired: 5 }
    })
    await page.getByLabel('Auto-delete meetings older than').selectOption('365')
    await expect.poll(async () => (await inspect()).patches).toEqual([{ transcriptRetentionDays: 365 }])
    expect((await inspect()).calls).not.toContain('retentionPreview')
    expect(await page.getByRole('alertdialog').count()).toBe(0)
  })

  it('an unwritable meetings folder is refused inline and the folder stays', async () => {
    await mount({ section: 'meetings', settings: SETTINGS, pickFolder: { ok: false, reason: 'not-writable' } })
    const change = page.getByRole('button', { name: 'Change folder' })
    await change.click()
    const alert = page.getByRole('alert').filter({ hasText: "can't save meetings in that folder" })
    await alert.waitFor()
    expect(await change.getAttribute('aria-describedby')).toBe(await alert.getAttribute('id'))
    expect(await page.getByText('/sandbox/Meetings').count()).toBe(1)
  })

  it('Launch at login shows the OS refusal with one way to fix it', async () => {
    await mount({
      section: 'meetings',
      settings: { ...SETTINGS, launchAtLogin: true, loginItemOpenAtLogin: true },
      osState: {
        loginItem: { supported: true, enabled: false, requiresApproval: true },
        notifications: { supported: true }
      }
    })
    const toggle = page.getByRole('switch', { name: 'Launch at login' })
    await page.getByText('macOS needs your approval before Métis can open at login.').waitFor()
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    const hintId = await toggle.getAttribute('aria-describedby')
    expect(await page.locator(`[id="${hintId}"]`).textContent()).toContain('needs your approval')
    await page.getByRole('button', { name: /^Open (System )?Settings$/ }).click()
    await expect
      .poll(async () => (await inspect()).callArgs.find((c) => c.name === 'openSystemSettings')?.args)
      .toEqual(['loginItems'])
  })

  it('Meeting alerts reflect an OS that cannot show notifications', async () => {
    await mount({
      section: 'calendar',
      settings: SETTINGS,
      osState: {
        loginItem: { supported: true, enabled: false, requiresApproval: false },
        notifications: { supported: false }
      }
    })
    await page.getByText("This computer isn't letting Métis show notifications.").waitFor()
    expect(await page.getByRole('switch', { name: 'Meeting alerts' }).getAttribute('aria-checked')).toBe('false')
  })

  it('the custom endpoint is validated next to the field, never saved when invalid, saved at once when valid', async () => {
    await mount({ section: 'endpoint', settings: SETTINGS })
    const field = page.getByLabel('Custom endpoint URL')
    await field.fill('http://insecure.example.invalid/v1')
    expect(await page.getByRole('alert').count()).toBe(0) // typing never shows an error
    await field.press('Tab')
    const alert = page.getByRole('alert')
    await alert.waitFor()
    expect(await alert.textContent()).toBe('Use an address that starts with https://.')
    expect(await field.getAttribute('aria-invalid')).toBe('true')
    expect(await field.getAttribute('aria-describedby')).toBe(await alert.getAttribute('id'))
    expect((await inspect()).patches).toEqual([])
    await field.fill('https://secure.example.invalid/v1')
    await field.press('Enter')
    await expect
      .poll(async () => (await inspect()).patches)
      .toEqual([{ customBaseUrl: 'https://secure.example.invalid/v1' }])
    expect(await page.getByRole('alert').count()).toBe(0)
  })

  it('a refused endpoint save is reported inline', async () => {
    await mount({ section: 'endpoint', settings: SETTINGS, refusePatch: true })
    const field = page.getByLabel('Custom endpoint URL')
    await field.fill('https://other.example.invalid/v1')
    await field.press('Enter')
    await page.getByRole('alert').waitFor()
    expect(await page.getByRole('alert').textContent()).toContain("didn't accept this value")
  })

  it('Screen Recording Repair asks before resetting the permission and relaunching', async () => {
    await mount({
      section: 'screen',
      settings: SETTINGS,
      diagnosis: {
        state: 'not-effective',
        reasons: ['grant-belongs-to-other-copy'],
        action: 'repair',
        duplicates: [],
        grantedFor: null,
        repairFailed: false
      }
    })
    const repair = page.getByRole('button', { name: 'Repair', exact: true })
    await repair.click()
    const sheet = page.getByRole('alertdialog', { name: 'Repair screen recording?' })
    await sheet.waitFor()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await sheet.waitFor({ state: 'detached' })
    expect((await inspect()).calls).not.toContain('repairScreenPermission')
    await repair.click()
    await page.keyboard.press('Enter') // deliberately chosen: Repair and Relaunch is the default
    await expect.poll(async () => (await inspect()).calls).toContain('repairScreenPermission')
  })

  it('the not-asked Screen Recording row has one Continue button that asks only for Screen Recording (HIG P3)', async () => {
    await mount({
      section: 'screen',
      settings: SETTINGS,
      diagnosis: {
        state: 'not-asked',
        reasons: [],
        action: 'request',
        duplicates: [],
        grantedFor: null,
        repairFailed: false
      }
    })
    expect(await page.getByRole('button', { name: /Allow/ }).count()).toBe(0)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect
      .poll(async () => (await inspect()).callArgs.find((c) => c.name === 'requestPermissionsUpfront')?.args)
      .toEqual(['screenRecording'])
  })
})
