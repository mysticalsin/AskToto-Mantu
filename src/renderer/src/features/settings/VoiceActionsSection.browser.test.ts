/**
 * Settings › Speech › Voice actions in a real Chromium DOM (V06): instant apply with no Save button, the Preview
 * badge, the managed lock, the "Hey Métis" row that says why it is off, the permission row that asks only on Continue,
 * and the chord recorder's keyboard flow (a lone modifier is a valid chord, Escape cancels, Tab is not trapped, a
 * refusal is explained inline). window.toto is stubbed; the section is the real component.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0voice-actions-harness'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { VoiceActionsSection } from ${modulePath('features/settings/VoiceActionsSection.tsx')}
import { Shortcuts } from ${modulePath('features/settings/Shortcuts.tsx')}
import { DEFAULT_SETTINGS, PublicSettingsSchema } from ${modulePath('../../shared/ipc.ts')}

const config = window.__voiceConfig
const calls = []
const record = (name, value) => (...args) => {
  calls.push({ name, args })
  return Promise.resolve(typeof value === 'function' ? value(...args) : value)
}
const snapshot = config.snapshot === undefined
  ? { revision: 1, state: 'idle', turnId: null, reason: null, message: null, enabled: false, shortcut: 'running' }
  : config.snapshot
const base = {
  getPermissions: config.permissions ?? { microphone: 'granted', screenRecording: 'granted' },
  getShortcutFailures: [],
  relaunch: undefined,
  requestPermissionsUpfront: undefined,
  openPermissionHelper: true,
  openPermissionSettings: undefined
}
window.__escapeReachedWindow = false
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escapeReachedWindow = true })
window.toto = new Proxy({
  voiceActions: {
    getState: () => { calls.push({ name: 'voiceActions.getState', args: [] }); return Promise.resolve(snapshot) },
    onState: () => () => {},
    setChordRecorderActive: (active) => { calls.push({ name: 'voiceActions.setChordRecorderActive', args: [active] }); return Promise.resolve({ ok: true }) }
  },
  conversation: { start: () => { calls.push({ name: 'conversation.start', args: [] }); return Promise.resolve({ ok: true }) } }
}, {
  get: (target, key) => {
    if (typeof key !== 'string') return undefined
    if (!(key in target)) target[key] = record(key, key in base ? base[key] : undefined)
    return target[key]
  }
})

let settings = PublicSettingsSchema.parse({
  ...DEFAULT_SETTINGS, hasApiKey: false, providerReady: false, visionReady: false, hasKeys: {}, hasEncryption: true,
  resolvedMeetingsFolder: '', ...config.settings
})
const patches = []
const patch = (next) => {
  patches.push(next)
  settings = { ...settings, ...next }
  rerender()
  return Promise.resolve(settings)
}
function Host() {
  return config.section === 'shortcuts'
    ? createElement(Shortcuts, { settings, patch })
    : createElement('div', { style: { position: 'relative', width: 640, minHeight: 480 } },
        createElement(VoiceActionsSection, { settings, patch, windows: !!config.windows }),
        createElement('button', { id: 'after-section' }, 'After'))
}
const root = createRoot(document.getElementById('root'))
const rerender = () => flushSync(() => root.render(createElement(Host)))
rerender()
window.__voice = {
  inspect: () => ({ calls: calls.map((c) => c.name), callArgs: calls, patches, settings, escape: window.__escapeReachedWindow }),
  unmount: () => flushSync(() => root.unmount())
}
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
        name: 'voice-actions-harness',
        enforce: 'pre',
        resolveId: (id: string) => (id === HARNESS_ID ? id : null),
        load: (id: string) => (id === HARNESS_ID ? HARNESS : null)
      },
      {
        name: 'voice-actions-onboarding-music-stub',
        enforce: 'pre',
        load: (id: string) =>
          /lib[\\/]onboarding-music\.ts$/.test(id)
            ? 'export const haltAllOnboardingAudio = () => {}\nexport const unlockOnboardingAudio = () => {}'
            : null
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
  patches: { voiceActions: Record<string, unknown> }[]
  settings: Record<string, unknown> & { voiceActions: Record<string, unknown> }
  escape: boolean
}

declare global {
  interface Window {
    __voiceConfig: Record<string, unknown>
    __voice: { inspect(): Inspect; unmount(): void }
  }
}

const ENABLED = { voiceActions: { enabled: true } }

describe('Settings › Speech › Voice actions (V06)', () => {
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
    page.on('pageerror', (error) => console.error('PAGEERROR', error.message))
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate((value) => {
      window.__voiceConfig = value
    }, config)
    await page.addScriptTag({ content: bundle })
  }
  const inspect = (): Promise<Inspect> => page.evaluate(() => window.__voice.inspect())
  const toggle = () => page.getByRole('switch', { name: 'Use voice actions', exact: true })
  const conversationToggle = () => page.getByRole('switch', { name: 'Enable continuous conversation', exact: true })
  const conversationStart = () => page.getByRole('button', { name: 'Start conversation', exact: true })
  const change = () => page.getByRole('button', { name: /^Change hold to talk shortcut/ })
  const recorder = () => page.getByRole('textbox', { name: 'Hold to talk shortcut' })
  const hold = async (key: string, ms: number): Promise<void> => {
    await page.keyboard.down(key)
    if (ms > 0) await page.waitForTimeout(ms)
    await page.keyboard.up(key)
  }
  const HOLD_MS = 520
  const isFocused = (locator: Locator): Promise<boolean> => locator.evaluate((el) => el === document.activeElement)

  it('opening the section asks the system for nothing, and only a Continue raises the microphone prompt', async () => {
    await mount({ settings: ENABLED, permissions: { microphone: 'unknown', screenRecording: 'granted' } })
    const row = page.locator('[data-permission-row="microphone"]')
    await row.waitFor()
    // One sentence of why, in view before any system prompt.
    expect(await row.textContent()).toContain('Voice actions listen only while you hold the shortcut.')
    const before = await inspect()
    for (const name of ['requestPermissionsUpfront', 'openPermissionHelper', 'openPermissionSettings']) {
      expect(before.calls, name).not.toContain(name)
    }
    expect(await page.getByRole('button', { name: /Input Monitoring|Allow/ }).count()).toBe(0)
    await row.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect
      .poll(async () => (await inspect()).callArgs.filter((c) => c.name === 'requestPermissionsUpfront'))
      .toEqual([{ name: 'requestPermissionsUpfront', args: ['microphone'] }])
  })

  it('a denied microphone offers one Open System Settings through the guided helper, and a granted one shows no row', async () => {
    await mount({ settings: ENABLED, permissions: { microphone: 'denied', screenRecording: 'granted' } })
    const row = page.locator('[data-permission-row="microphone"]')
    await row.waitFor()
    await row.getByRole('button', { name: 'Open System Settings', exact: true }).click()
    await expect
      .poll(async () => (await inspect()).callArgs.filter((c) => c.name === 'openPermissionHelper'))
      .toEqual([{ name: 'openPermissionHelper', args: ['microphone'] }])
    await page.close()
    page = await browser.newPage()
    await mount({ settings: ENABLED, permissions: { microphone: 'granted', screenRecording: 'granted' } })
    await toggle().waitFor()
    expect(await page.locator('[data-permission-row]').count()).toBe(0)
  })

  it('shows no permission row while voice actions are off', async () => {
    await mount({
      settings: { voiceActions: { enabled: false } },
      permissions: { microphone: 'unknown', screenRecording: 'granted' }
    })
    await toggle().waitFor()
    expect(await page.locator('[data-permission-row]').count()).toBe(0)
  })

  it('requires voice actions and explicit conversation opt-in before the user can start', async () => {
    await mount({ settings: { voiceActions: { enabled: true, conversation: { enabled: false } } } })
    await conversationToggle().waitFor()
    expect(await conversationToggle().getAttribute('aria-checked')).toBe('false')
    expect(await conversationStart().isDisabled()).toBe(true)
    await conversationToggle().click()
    await expect.poll(() => conversationToggle().getAttribute('aria-checked')).toBe('true')
    expect(await conversationStart().isDisabled()).toBe(false)
    expect((await inspect()).callArgs.some((call) => call.name === 'conversation.start')).toBe(false)
    await conversationStart().click()
    await expect.poll(async () => (await inspect()).callArgs.some((call) => call.name === 'conversation.start')).toBe(true)
    expect(await page.locator('[data-metis-conversation-start]').count()).toBe(1)
    await page.close()
    page = await browser.newPage()
    await mount({ settings: { voiceActions: { enabled: true, conversation: { enabled: true } }, enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: false } } })
    await conversationToggle().waitFor()
    expect(await conversationStart().isDisabled()).toBe(true)
  })

  it('a release build that follows the build default shows the Preview badge, off, and turning it on applies at once with no Save', async () => {
    await mount({
      settings: {},
      snapshot: {
        revision: 1,
        state: 'off',
        turnId: null,
        reason: null,
        message: null,
        enabled: false,
        shortcut: 'stopped'
      }
    })
    await page.getByText('Preview', { exact: true }).waitFor()
    expect(await toggle().getAttribute('aria-checked')).toBe('false')
    expect(await page.getByRole('button', { name: /^Save/ }).count()).toBe(0)
    await toggle().click()
    await expect.poll(async () => (await inspect()).patches.map((p) => p.voiceActions.enabled)).toEqual([true])
    await expect.poll(() => toggle().getAttribute('aria-checked')).toBe('true')
    expect(await page.getByText('Preview', { exact: true }).count()).toBe(0)
  })

  it('a QA build that follows the build default is on and shows no Preview badge', async () => {
    await mount({
      settings: {},
      snapshot: {
        revision: 1,
        state: 'idle',
        turnId: null,
        reason: null,
        message: null,
        enabled: true,
        shortcut: 'running'
      }
    })
    await expect.poll(() => toggle().getAttribute('aria-checked')).toBe('true')
    expect(await page.getByText('Preview', { exact: true }).count()).toBe(0)
  })

  it('a chosen off stays off in a QA build, with no Preview badge (the person chose)', async () => {
    await mount({
      settings: { voiceActions: { enabled: false } },
      snapshot: {
        revision: 1,
        state: 'off',
        turnId: null,
        reason: null,
        message: null,
        enabled: false,
        shortcut: 'stopped'
      }
    })
    await toggle().waitFor()
    expect(await toggle().getAttribute('aria-checked')).toBe('false')
    expect(await page.getByText('Preview', { exact: true }).count()).toBe(0)
  })

  it('a managed lock dims and disables every control, says why, and a click changes nothing', async () => {
    await mount({ settings: { managedKeys: ['voiceActions'], voiceActions: { enabled: true } } })
    await toggle().waitFor()
    expect(await toggle().isDisabled()).toBe(true)
    expect(await change().isDisabled()).toBe(true)
    expect(await page.getByRole('switch', { name: 'Double press to keep listening' }).isDisabled()).toBe(true)
    expect(await page.locator('section').textContent()).toContain('Managed by your organization')
    expect(await page.locator('section').textContent()).toContain(
      "Your organization sets this. You can't change it here."
    )
    await toggle().click({ force: true })
    await change().click({ force: true })
    expect((await inspect()).patches).toEqual([])
    expect(await page.locator('[data-voice-chord-recorder="recording"]').count()).toBe(0)
  })

  it('a cloud-only organization sees why voice actions are off and cannot turn them on', async () => {
    await mount({
      settings: {
        enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: false },
        voiceActions: { enabled: true }
      }
    })
    await toggle().waitFor()
    expect(await toggle().isDisabled()).toBe(true)
    expect(await toggle().getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('section').textContent()).toContain(
      'Your organization requires cloud speech. Voice actions use on-device speech.'
    )
    // The cloud policy is not a managed lock on the voiceActions key, so it does not claim to be one.
    expect(await page.locator('section').textContent()).not.toContain('Your organization sets this.')
    expect((await inspect()).patches).toEqual([])
  })

  it('"Hey Métis" is off and disabled with an honest reason while its gate is closed, even if the profile says on', async () => {
    await mount({ settings: { voiceActions: { enabled: true, wakeWord: true } } })
    const wake = page.getByRole('switch', { name: 'Listen for “Hey Métis”' })
    await wake.waitFor()
    expect(await wake.isDisabled()).toBe(true)
    expect(await wake.getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('section').textContent()).toContain('Not available yet.')
    await wake.click({ force: true })
    expect((await inspect()).patches).toEqual([])
  })

  it('the double press option is off by default, names the macOS Dictation collision, and applies at once', async () => {
    await mount({ settings: ENABLED })
    const latch = page.getByRole('switch', { name: 'Double press to keep listening' })
    await latch.waitFor()
    expect(await latch.getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('section').textContent()).toContain('pressing Right ⌘ twice can also start Dictation')
    await latch.click()
    await expect.poll(async () => (await inspect()).patches.map((p) => p.voiceActions.doublePressLatch)).toEqual([true])
  })

  it('with voice actions off the sub-rows are dimmed and not operable', async () => {
    await mount({ settings: { voiceActions: { enabled: false } } })
    await toggle().waitFor()
    expect(await page.locator('[data-voice-sub-rows]').getAttribute('data-voice-sub-rows')).toBe('disabled')
    expect(await change().isDisabled()).toBe(true)
    expect(await page.getByRole('switch', { name: 'Double press to keep listening' }).isDisabled()).toBe(true)
  })

  it('shows the Windows default as Right Ctrl and refuses the Windows key inline', async () => {
    await mount({ settings: ENABLED, windows: true })
    await page.getByText('Right Ctrl', { exact: true }).waitFor()
    await change().click()
    await recorder().waitFor()
    await hold('MetaRight', HOLD_MS)
    await page.getByText('The Windows key opens Start. Choose Ctrl or Alt instead.').waitFor()
    expect((await inspect()).patches).toEqual([])
  })

  describe('the chord recorder keyboard flow', () => {
    it('holding one modifier, Right ⌘, and letting go is accepted as the chord, and it applies at once', async () => {
      await mount({
        settings: { voiceActions: { enabled: true, holdChord: { mac: ['leftAlt'], win: ['rightControl'] } } }
      })
      await change().click()
      expect(await isFocused(recorder())).toBe(true)
      expect((await inspect()).callArgs.filter((c) => c.name === 'voiceActions.setChordRecorderActive')).toEqual([
        { name: 'voiceActions.setChordRecorderActive', args: [true] }
      ])
      expect(await page.locator('[data-voice-chord-recorder]').textContent()).toContain(
        'Hold the keys you want, then let go.'
      )
      await hold('MetaRight', HOLD_MS)
      await expect
        .poll(async () => (await inspect()).patches.map((p) => p.voiceActions.holdChord))
        .toEqual([{ mac: ['rightCommand'], win: ['rightControl'] }])
      await page.locator('[data-voice-chord-recorder="idle"]').waitFor()
      expect(await isFocused(change())).toBe(true)
      expect(await page.getByText('Right ⌘', { exact: true }).count()).toBe(1)
      // Closing the recorder released the pause on the global hold.
      expect(
        (await inspect()).callArgs.filter((c) => c.name === 'voiceActions.setChordRecorderActive').map((c) => c.args[0])
      ).toEqual([true, false])
    })

    it('records two modifiers held together as one chord, in a fixed order', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await page.keyboard.down('AltLeft')
      await page.keyboard.down('ControlLeft')
      await page.waitForTimeout(HOLD_MS)
      await page.keyboard.up('AltLeft')
      await page.keyboard.up('ControlLeft')
      await expect
        .poll(async () => (await inspect()).patches.map((p) => p.voiceActions.holdChord))
        .toEqual([{ mac: ['leftControl', 'leftAlt'], win: ['rightControl'] }])
      // The VoiceOver collision is explained beside the chord that has it.
      await page.getByText('VoiceOver uses Control and Option together.', { exact: false }).waitFor()
    })

    it('Escape cancels without changing the chord, returns focus, and does not close the surrounding panel', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await page.keyboard.press('Escape')
      await page.locator('[data-voice-chord-recorder="idle"]').waitFor()
      expect(await isFocused(change())).toBe(true)
      const after = await inspect()
      expect(after.patches).toEqual([])
      expect(after.escape).toBe(false)
      expect(
        after.callArgs.filter((c) => c.name === 'voiceActions.setChordRecorderActive').map((c) => c.args[0])
      ).toEqual([true, false])
    })

    it('Tab leaves the recorder: it is not a keyboard trap, and the pause on the hold is released', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await page.keyboard.press('Tab')
      await page.locator('[data-voice-chord-recorder="idle"]').waitFor()
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).not.toBe(
        'Hold to talk shortcut'
      )
      expect((await inspect()).patches).toEqual([])
      expect(
        (await inspect()).callArgs.filter((c) => c.name === 'voiceActions.setChordRecorderActive').map((c) => c.args[0])
      ).toEqual([true, false])
    })

    it('a hold that is too short asks for a longer one and keeps recording', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await hold('MetaRight', 0)
      await page.getByText('Hold the keys a little longer, then let go.').waitFor()
      expect(await recorder().isVisible()).toBe(true)
      expect((await inspect()).patches).toEqual([])
    })

    it('Shift on its own is refused inline next to the field and recording continues', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await hold('ShiftLeft', HOLD_MS)
      await page.getByText('Shift alone is held while you type. Choose another key, like Right ⌘.').waitFor()
      expect(await recorder().isVisible()).toBe(true)
      expect(await page.getByRole('alertdialog').count()).toBe(0)
      expect((await inspect()).patches).toEqual([])
      // The next hold is accepted without reopening the recorder.
      await hold('MetaRight', HOLD_MS)
      await expect.poll(async () => (await inspect()).patches.length).toBe(1)
    })

    it('a letter key is refused with a sentence, not recorded', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await page.keyboard.press('KeyA')
      await page.getByText('Only modifier keys work here. Hold Right ⌘ or another modifier on its own.').waitFor()
      expect((await inspect()).patches).toEqual([])
    })

    it('Restore default appears only for a changed chord and puts the default back', async () => {
      await mount({
        settings: { voiceActions: { enabled: true, holdChord: { mac: ['leftAlt'], win: ['rightControl'] } } }
      })
      const restore = page.getByRole('button', { name: 'Restore default', exact: true })
      await restore.click()
      await expect
        .poll(async () => (await inspect()).patches.map((p) => p.voiceActions.holdChord))
        .toEqual([{ mac: ['rightCommand'], win: ['rightControl'] }])
      await expect.poll(() => restore.count()).toBe(0)
    })

    it('leaving the section while recording releases the pause on the hold', async () => {
      await mount({ settings: ENABLED })
      await change().click()
      await recorder().waitFor()
      await page.evaluate(() => window.__voice.unmount())
      const calls = (await inspect()).callArgs
        .filter((c) => c.name === 'voiceActions.setChordRecorderActive')
        .map((c) => c.args[0])
      expect(calls).toEqual([true, false])
    })
  })

  it('the Keyboard shortcuts list shows the voice chord read-only and points to the Speech tab', async () => {
    await mount({ section: 'shortcuts', settings: ENABLED })
    const row = page.locator('[data-voice-shortcut-row]')
    await row.waitFor()
    const text = (await row.textContent()) ?? ''
    expect(text).toContain('Voice actions')
    expect(text).toContain('Change it in Settings › Speech.')
    expect(await row.locator('input, button').count()).toBe(0)
  })
})
