// WP14 sandbox acceptance, opt-in scenario `--scenario settings-hig` (C28): the Apple HIG Settings behaviour of the installed
// QA-identity build, observed through the real renderer over loopback CDP. Every step PASSES only on something it observed in
// the running app; a build that lacks a surface reports NOT_SUPPORTED with the reason, never PASS.
//
// Keyboard input is real: Input.dispatchKeyEvent is sent over CDP (a trusted event, the same path Playwright uses), never a
// synthetic DOM dispatchEvent. Clicks go through Playwright locators (also trusted). Nothing here starts a microphone, and the
// mic step installs a getUserMedia counter so "no capture request" is a count the page reported, not an inference.
//
// Pure helpers (key-event builders, classifiers, step shaping) are exported for unit tests and take the platform as an input.
import { sleep, waitFor } from '../lib/app-driver.mjs'
import { runStep } from './lib.mjs'

/** Ordered step ids of the scenario, as `--dry-run` prints them. */
export const SETTINGS_HIG_STEPS = Object.freeze([
  'launch-and-renderer-ready',
  'settings-shortcut-opens',
  'settings-toggle-applies-without-save',
  'settings-confirm-escape-cancels',
  'settings-audio-no-mic-request',
  'settings-endpoint-inline-validation',
  'clean-quit',
  'relaunch',
  'settings-last-pane-restored',
  'settings-endpoint-unchanged-after-relaunch',
  'settings-toggle-persisted-after-relaunch',
  'final-quit'
])

/**
 * Settings seeded for this scenario only. provider 'custom' with a valid https endpoint makes the Custom endpoint field render
 * in Settings > AI without any UI detour; the invalid-endpoint step then proves that value is the one that survives.
 */
export const HIG_SEED_SETTINGS = Object.freeze({
  provider: 'custom',
  customBaseUrl: 'https://qa-endpoint.example.invalid/v1'
})

/** A plain, reversible preference in Settings > Privacy (default off) that nothing else reads at launch. */
export const TOGGLE = Object.freeze({
  tabId: 'privacy',
  label: 'Carry context into follow-up questions',
  key: 'askFollowUpMemory'
})
export const INSECURE_ENDPOINT = 'http://insecure.example.invalid/v1'
export const ENDPOINT_FIELD_LABEL = 'Custom endpoint URL'
export const LAST_PANE_KEY = 'metis.settings.lastPane'
export const DEFAULT_PANE_TAB_ID = 'settings-tab-personalize'
export const REPLAY = Object.freeze({ trigger: 'Replay onboarding', title: 'Replay onboarding?', confirm: 'Replay' })

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

/** Input.dispatchKeyEvent modifier bit mask. */
export const CDP_MODIFIERS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 })

/**
 * The down/up pair for one non-text key, shaped for CDP Input.dispatchKeyEvent. `rawKeyDown` (not `keyDown`) because none of
 * these keys produces text; `commands: []` stops Chromium from also running an editing command for the chord.
 * @param {{ key: string, code: string, keyCode: number, nativeKeyCode?: number, modifiers?: number }} spec
 */
export function buildKeyEvents({ key, code, keyCode, nativeKeyCode = keyCode, modifiers = 0 }) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: nativeKeyCode,
    modifiers,
    commands: []
  }
  return [
    { type: 'rawKeyDown', ...common },
    { type: 'keyUp', ...common }
  ]
}

/** The platform's Settings chord: Command-Comma on macOS, Control-Comma on Windows (src/renderer/src/lib/overlay-window-effects.ts). */
export function settingsShortcutEvents(platform = process.platform) {
  const windows = platform === 'win32'
  return buildKeyEvents({
    key: ',',
    code: 'Comma',
    keyCode: 188,
    nativeKeyCode: windows ? 188 : 43,
    modifiers: windows ? CDP_MODIFIERS.ctrl : CDP_MODIFIERS.meta
  })
}

export const escapeKeyEvents = () => buildKeyEvents({ key: 'Escape', code: 'Escape', keyCode: 27, nativeKeyCode: 53 })

/** Mic-capture audit records: the build has no dedicated one, so this names the families a capture start would write. */
export function isMicCaptureAuditEvent(event) {
  return (
    typeof event === 'string' &&
    event !== 'qa.capture.file_source' &&
    /^(listen\.|mic\.|meeting\.(start|started|live)|capture\.(mic|audio|start))/.test(event)
  )
}

/**
 * Wrap a list of problems and the evidence gathered into a step result: any problem is a FAIL (thrown, so runStep records the
 * reason), none returns the evidence. There is no way to PASS with a problem.
 * @param {{ problems: string[], evidence: Record<string, unknown> }} args
 */
export function shapeObservation({ problems, evidence }) {
  if (problems.length) throw new Error(`${problems.join('; ')} (observed ${JSON.stringify(evidence)})`)
  return { evidence }
}

/**
 * What a post-relaunch step does when the step it verifies did not PASS: null to run, NOT_SUPPORTED when that step was
 * NOT_SUPPORTED, SKIPPED otherwise (it never runs and never passes).
 * @param {{ id: string, status: string, reason?: string }[]} steps
 */
export function dependentOutcome(steps, id) {
  const step = steps.find((candidate) => candidate.id === id)
  if (step?.status === 'PASS') return null
  if (step?.status === 'NOT_SUPPORTED')
    return {
      status: 'NOT_SUPPORTED',
      reason: `depends on ${id}, which is not supported by this build: ${step.reason}`,
      evidence: {}
    }
  return { status: 'SKIPPED', reason: `requires ${id} to PASS`, evidence: {} }
}

/**
 * Settings > Speech with the microphone not yet granted: no capture request, and the matching control.
 * unknown (macOS "not determined") shows "Test Microphone"; denied shows the System Settings link and never "Test Microphone".
 * @param {{ status: string | null, getUserMediaCalls: number, micAuditEvents: string[], testButtonVisible: boolean, openSettingsVisible: boolean, platform?: string }} observation
 * @returns {{ supported: boolean, reason?: string, problems: string[] }}
 */
export function classifyMicObservation({
  status,
  getUserMediaCalls,
  micAuditEvents,
  testButtonVisible,
  openSettingsVisible
}) {
  if (status === 'granted' || status === 'not-required')
    return {
      supported: false,
      reason: `microphone permission is "${status}" in this sandbox profile, so the not-granted path cannot be observed (a granted microphone meters by design)`,
      problems: []
    }
  const problems = []
  if (status !== 'unknown' && status !== 'denied')
    problems.push(`window.toto.getPermissions() reported microphone ${JSON.stringify(status)}`)
  if (getUserMediaCalls > 0)
    problems.push(`the Audio pane called getUserMedia ${getUserMediaCalls} time(s) before any click`)
  if (micAuditEvents.length) problems.push(`audit log recorded ${micAuditEvents.join(', ')}`)
  if (status === 'unknown' && !testButtonVisible) problems.push('"Test Microphone" is not visible')
  if (status === 'denied') {
    if (testButtonVisible) problems.push('"Test Microphone" is shown although access is denied')
    if (!openSettingsVisible) problems.push('no button opens the system microphone settings')
  }
  return { supported: true, problems }
}

/**
 * The invalid custom endpoint: an inline alert linked by aria-describedby, aria-invalid on the field, no blocking alert dialog,
 * and the stored value unchanged.
 */
export function classifyEndpointObservation({
  describedBy,
  alertId,
  alertRole,
  alertText,
  ariaInvalid,
  blockingAlertDialogs,
  baseline,
  stored
}) {
  const problems = []
  if (!describedBy) problems.push('the field has no aria-describedby after blur')
  else if (alertId !== describedBy) problems.push('aria-describedby does not point at the visible error')
  if (alertRole !== 'alert') problems.push(`the error has role ${JSON.stringify(alertRole)}, not "alert"`)
  if (!alertText || !alertText.trim()) problems.push('the error is empty')
  if (ariaInvalid !== 'true') problems.push('the field is not aria-invalid')
  if (blockingAlertDialogs > 0) problems.push('a blocking alert dialog appeared')
  if (stored !== baseline) problems.push('the stored endpoint changed after invalid input')
  return problems
}

/**
 * The confirmation sheet opened by "Replay onboarding" and dismissed with Escape.
 * @param {{ role: string | null, title: string | null, buttons: string[], focusedLabel: string | null, closedAfterEscape: boolean, settingsStillOpen: boolean, onboardingDoneBefore: boolean, onboardingDoneAfter: boolean }} observation
 */
export function classifyConfirmObservation({
  role,
  title,
  buttons,
  focusedLabel,
  closedAfterEscape,
  settingsStillOpen,
  onboardingDoneBefore,
  onboardingDoneAfter
}) {
  const problems = []
  if (role !== 'alertdialog') problems.push(`the sheet has role ${JSON.stringify(role)}, not "alertdialog"`)
  if (title !== REPLAY.title) problems.push(`the sheet title is ${JSON.stringify(title)}`)
  if (buttons.join('|') !== `Cancel|${REPLAY.confirm}`)
    problems.push(`the sheet buttons are ${JSON.stringify(buttons)}`)
  if (focusedLabel !== REPLAY.confirm)
    problems.push(`focus is on ${JSON.stringify(focusedLabel)}, not the default "${REPLAY.confirm}"`)
  if (!closedAfterEscape) problems.push('Escape did not close the sheet')
  if (!settingsStillOpen) problems.push('Escape also closed Settings')
  if (onboardingDoneBefore !== true || onboardingDoneAfter !== true)
    problems.push(`onboardingDone went ${onboardingDoneBefore} -> ${onboardingDoneAfter}; Cancel must change nothing`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// CDP and page helpers

/** Send a prepared key-event list to the page with Input.dispatchKeyEvent (real, trusted input). */
export async function dispatchKeyEvents(page, events) {
  const cdp = await page.context().newCDPSession(page)
  try {
    // Without focus emulation a window that is not frontmost on the desktop drops key events.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    for (const event of events) await cdp.send('Input.dispatchKeyEvent', event)
  } finally {
    await cdp.detach().catch(() => {})
  }
}

const tablistOf = (page) => page.getByRole('tablist', { name: 'Settings sections' })
const settingsRootOf = (page) => page.locator('.cl-root')

/** Only the fields the steps compare; never the whole settings object (no keys, paths or names enter a report). */
const readSettingsSummary = (page) =>
  page.evaluate(async () => {
    const settings = await window.toto.getSettings()
    return {
      provider: settings.provider,
      customBaseUrl: settings.customBaseUrl,
      onboardingDone: settings.onboardingDone,
      askFollowUpMemory: settings.askFollowUpMemory
    }
  })

export async function openSettingsTab(page, tabId) {
  await page.locator(`#settings-tab-${tabId}`).click({ timeout: 10_000 })
  await waitFor(
    async () => (await page.locator(`#settings-tab-${tabId}`).getAttribute('aria-selected')) === 'true',
    `Settings tab ${tabId} did not become selected`,
    8_000
  )
}

const selectedTabId = (page) => page.locator('[role=tab][aria-selected=true]').first().getAttribute('id')

// ---------------------------------------------------------------------------------------------------------------
// Steps (each returns evidence it observed, or throws)

/** Command-Comma, delivered as a real CDP key event, opens Settings. */
export async function settingsShortcutOpens(session, { platform = process.platform } = {}) {
  const page = await session.connect()
  const tablist = tablistOf(page)
  if ((await tablist.count()) > 0)
    throw new Error('Settings was already open before the shortcut, so it cannot be attributed to the shortcut')
  await dispatchKeyEvents(page, settingsShortcutEvents(platform))
  try {
    await tablist.waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    throw new Error(`the Settings tablist did not appear after the shortcut: ${error.message}`)
  }
  return {
    evidence: {
      shortcut: platform === 'win32' ? 'Control-Comma' : 'Command-Comma',
      deliveredWith: 'CDP Input.dispatchKeyEvent',
      tablistVisible: true,
      tabCount: await page.getByRole('tab').count(),
      openedOnTab: await selectedTabId(page)
    }
  }
}

/** A plain toggle takes effect at once: the switch flips, no Save-style button exists, and main reports the new value. */
export async function toggleAppliesWithoutSave(session, ctx) {
  const page = await session.connect()
  await openSettingsTab(page, TOGGLE.tabId)
  const toggle = page.getByRole('switch', { name: TOGGLE.label, exact: true })
  try {
    await toggle.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    return {
      status: 'NOT_SUPPORTED',
      reason: `this build has no "${TOGGLE.label}" switch in Settings > Privacy`,
      evidence: { tab: TOGGLE.tabId }
    }
  }
  if (await toggle.isDisabled())
    return {
      status: 'NOT_SUPPORTED',
      reason: `"${TOGGLE.label}" is managed by policy in this profile`,
      evidence: { tab: TOGGLE.tabId, disabled: true }
    }
  const before = (await toggle.getAttribute('aria-checked')) === 'true'
  await toggle.click({ timeout: 10_000 })
  await waitFor(
    async () => (await toggle.getAttribute('aria-checked')) === String(!before),
    'the switch did not change state after the click',
    8_000
  )
  const stored = await waitFor(
    async () => {
      const settings = await readSettingsSummary(page)
      return settings[TOGGLE.key] === !before ? settings : null
    },
    'window.toto.getSettings() never reported the new value',
    10_000,
    250
  )
  const saveButtons = await settingsRootOf(page)
    .getByRole('button', { name: /^(save|apply|ok)$/i })
    .count()
  ctx.toggle = { before, after: stored[TOGGLE.key] }
  return shapeObservation({
    problems: saveButtons > 0 ? [`${saveButtons} Save/Apply/OK button(s) are present in Settings`] : [],
    evidence: {
      setting: TOGGLE.key,
      valueBefore: before,
      valueAfter: stored[TOGGLE.key],
      switchAriaCheckedFlipped: true,
      settingsGetReportsNewValue: true,
      saveButtonsInSettings: saveButtons
    }
  })
}

/** "Replay onboarding" asks first: default button focused, Escape cancels, nothing changes, Settings stays open. */
export async function confirmEscapeCancels(session) {
  const page = await session.connect()
  const before = await readSettingsSummary(page)
  const trigger = page.getByRole('button', { name: REPLAY.trigger, exact: true })
  try {
    await trigger.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    return {
      status: 'NOT_SUPPORTED',
      reason: `this build has no "${REPLAY.trigger}" button in Settings`,
      evidence: {}
    }
  }
  await trigger.click({ timeout: 10_000 })
  const dialog = page.getByRole('alertdialog')
  try {
    await dialog.waitFor({ state: 'visible', timeout: 8_000 })
  } catch (error) {
    throw new Error(`no confirmation sheet appeared after "${REPLAY.trigger}": ${error.message}`)
  }
  const sheet = await page.evaluate(() => {
    const element = document.querySelector('[role=alertdialog]')
    const labelOf = (node) => (node?.textContent ?? '').trim()
    const active = document.activeElement
    return {
      role: element?.getAttribute('role') ?? null,
      title: labelOf(document.getElementById(element?.getAttribute('aria-labelledby') ?? '')),
      buttons: [...(element?.querySelectorAll('button') ?? [])].map(labelOf),
      focusedLabel: active && element?.contains(active) ? labelOf(active) : null
    }
  })
  await dispatchKeyEvents(page, escapeKeyEvents())
  const closedAfterEscape = await waitFor(
    async () => (await page.getByRole('alertdialog').count()) === 0,
    'the confirmation sheet is still open after Escape',
    5_000
  )
    .then(() => true)
    .catch(() => false)
  await sleep(500)
  const after = await readSettingsSummary(page)
  const settingsStillOpen = (await tablistOf(page).count()) > 0
  const focusAfter = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
  return shapeObservation({
    problems: classifyConfirmObservation({
      ...sheet,
      closedAfterEscape,
      settingsStillOpen,
      onboardingDoneBefore: before.onboardingDone,
      onboardingDoneAfter: after.onboardingDone
    }),
    evidence: {
      confirmation: REPLAY.title,
      role: sheet.role,
      buttonOrder: sheet.buttons,
      focusedOnOpen: sheet.focusedLabel,
      escapeClosedSheet: closedAfterEscape,
      settingsStillOpen,
      onboardingDoneUnchanged: after.onboardingDone === before.onboardingDone,
      focusReturnedToTrigger: focusAfter === REPLAY.trigger
    }
  })
}

/**
 * Opening Settings > Speech with the microphone not granted makes no capture request and offers the matching control.
 * A getUserMedia counter is installed first, so "no capture request" is the page's own count.
 */
export async function audioPaneMakesNoMicRequest(session, { platform = process.platform } = {}) {
  const page = await session.connect()
  await page.evaluate(() => {
    const devices = navigator.mediaDevices
    if (!devices || devices.__metisHigCounter) return
    window.__metisHigGetUserMedia = 0
    const original = devices.getUserMedia.bind(devices)
    devices.getUserMedia = (...args) => {
      window.__metisHigGetUserMedia += 1
      return original(...args)
    }
    devices.__metisHigCounter = true
  })
  const auditBefore = session.audit().length
  await openSettingsTab(page, 'audio')
  await sleep(3_000) // the meter's mount effects have run by now
  const status = await page.evaluate(async () => {
    const permissions = await window.toto.getPermissions()
    return typeof permissions?.microphone === 'string' ? permissions.microphone : null
  })
  const getUserMediaCalls = await page.evaluate(() => window.__metisHigGetUserMedia ?? 0)
  const micAuditEvents = session
    .audit()
    .slice(auditBefore)
    .map((record) => record.event)
    .filter(isMicCaptureAuditEvent)
  const testButtonVisible = await page.getByRole('button', { name: 'Test Microphone', exact: true }).isVisible()
  const openSettingsName = platform === 'win32' ? 'Open Windows Settings' : 'Open System Settings'
  const openSettingsVisible = await page
    .getByRole('button', { name: openSettingsName, exact: true })
    .first()
    .isVisible()
  const verdict = classifyMicObservation({
    status,
    getUserMediaCalls,
    micAuditEvents,
    testButtonVisible,
    openSettingsVisible
  })
  const evidence = {
    microphonePermission: status,
    getUserMediaCalls,
    micCaptureAuditRecords: micAuditEvents.length,
    testMicrophoneVisible: testButtonVisible,
    openSettingsVisible,
    micAuditNote:
      'this build writes no dedicated mic-capture audit event; the getUserMedia count is the primary observation'
  }
  if (!verdict.supported) return { status: 'NOT_SUPPORTED', reason: verdict.reason, evidence }
  return shapeObservation({ problems: verdict.problems, evidence })
}

/** A non-https custom endpoint is explained next to the field (role=alert, aria-describedby) and never saved. */
export async function endpointInlineValidation(session, ctx) {
  const page = await session.connect()
  const settings = await readSettingsSummary(page)
  await openSettingsTab(page, 'ai')
  const field = page.getByLabel(ENDPOINT_FIELD_LABEL, { exact: true })
  try {
    await field.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    if (settings.provider !== 'custom')
      throw new Error(`the profile seed did not take: provider is ${JSON.stringify(settings.provider)}, not "custom"`)
    return {
      status: 'NOT_SUPPORTED',
      reason: `this build has no labelled "${ENDPOINT_FIELD_LABEL}" field (it predates inline endpoint validation)`,
      evidence: { provider: settings.provider }
    }
  }
  const baseline = settings.customBaseUrl
  await field.fill(INSECURE_ENDPOINT)
  await field.blur()
  const describedBy = await waitFor(
    () => field.getAttribute('aria-describedby'),
    'the field never got an aria-describedby after blur',
    5_000
  ).catch(() => null)
  const alert = await page.evaluate((id) => {
    const element = id ? document.getElementById(id) : null
    return {
      alertId: element?.id ?? null,
      alertRole: element?.getAttribute('role') ?? null,
      alertText: element?.textContent ?? ''
    }
  }, describedBy)
  const ariaInvalid = await field.getAttribute('aria-invalid')
  await sleep(1_500) // a save that slipped through would have landed by now
  const stored = (await readSettingsSummary(page)).customBaseUrl
  const blockingAlertDialogs = await page.getByRole('alertdialog').count()
  ctx.endpoint = { baseline }
  return shapeObservation({
    problems: classifyEndpointObservation({
      describedBy,
      ...alert,
      ariaInvalid,
      blockingAlertDialogs,
      baseline,
      stored
    }),
    evidence: {
      invalidValueTried: 'http:// address',
      errorRole: alert.alertRole,
      errorLinkedByAriaDescribedBy: describedBy !== null && alert.alertId === describedBy,
      ariaInvalid,
      errorChars: alert.alertText.trim().length,
      blockingAlertDialogs,
      storedEndpointUnchanged: stored === baseline
    }
  })
}

/** After a relaunch, Command-Comma reopens Settings on the pane that was last viewed. */
export async function lastPaneRestored(session, ctx, { platform = process.platform } = {}) {
  const page = await session.connect()
  if ((await tablistOf(page).count()) > 0) throw new Error('Settings is already open after the relaunch')
  await dispatchKeyEvents(page, settingsShortcutEvents(platform))
  await tablistOf(page).waitFor({ state: 'visible', timeout: 10_000 })
  const expected = `settings-tab-${ctx.lastPane}`
  const opened = await selectedTabId(page)
  const stored = await page.evaluate((key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }, LAST_PANE_KEY)
  return shapeObservation({
    problems: [
      ...(opened !== expected ? [`Settings opened on ${opened}, not the last-viewed ${expected}`] : []),
      ...(expected === DEFAULT_PANE_TAB_ID
        ? ['the last-viewed pane equals the default pane, so this proves nothing']
        : [])
    ],
    evidence: {
      lastViewedBeforeQuit: ctx.lastPane,
      openedOn: opened,
      storedPane: stored,
      defaultPane: DEFAULT_PANE_TAB_ID
    }
  })
}

/** After a relaunch, the invalid endpoint was never saved: the field and the stored setting still hold the baseline. */
export async function endpointUnchangedAfterRelaunch(session, ctx) {
  const page = await session.connect()
  await openSettingsTab(page, 'ai')
  const field = page.getByLabel(ENDPOINT_FIELD_LABEL, { exact: true })
  await field.waitFor({ state: 'visible', timeout: 8_000 })
  const shown = await field.inputValue()
  const stored = (await readSettingsSummary(page)).customBaseUrl
  return shapeObservation({
    problems: [
      ...(stored !== ctx.endpoint.baseline
        ? ['the stored endpoint differs from the one before the invalid input']
        : []),
      ...(shown !== ctx.endpoint.baseline
        ? ['the field shows a different endpoint than the one before the invalid input']
        : []),
      ...(stored === INSECURE_ENDPOINT || shown === INSECURE_ENDPOINT ? ['the insecure endpoint was persisted'] : [])
    ],
    evidence: {
      storedMatchesBaseline: stored === ctx.endpoint.baseline,
      fieldMatchesBaseline: shown === ctx.endpoint.baseline,
      insecureEndpointPersisted: false
    }
  })
}

/** After a relaunch, the toggled preference kept its new value with no Save step in between. */
export async function togglePersistedAfterRelaunch(session, ctx) {
  const page = await session.connect()
  await openSettingsTab(page, TOGGLE.tabId)
  const toggle = page.getByRole('switch', { name: TOGGLE.label, exact: true })
  await toggle.waitFor({ state: 'visible', timeout: 8_000 })
  const shown = (await toggle.getAttribute('aria-checked')) === 'true'
  const stored = (await readSettingsSummary(page))[TOGGLE.key]
  return shapeObservation({
    problems: [
      ...(stored !== ctx.toggle.after ? [`the stored value is ${stored}, expected ${ctx.toggle.after}`] : []),
      ...(shown !== ctx.toggle.after ? [`the switch shows ${shown}, expected ${ctx.toggle.after}`] : [])
    ],
    evidence: {
      setting: TOGGLE.key,
      expected: ctx.toggle.after,
      stored,
      switchShows: shown,
      valueBeforeTheRun: ctx.toggle.before
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario

/** Clean quit through the app's own IPC, as in the meeting scenario. */
export async function cleanQuit(session) {
  const quit = await session.quit()
  if (!quit.cleanShutdown) throw new Error(`the app did not exit cleanly (request ${quit.request}, exit ${quit.exit})`)
  if (!quit.cleanShutdownRecord) throw new Error('the app exited but wrote no app.shutdown.clean audit record')
  if (quit.leftovers.length) throw new Error(`${quit.leftovers.length} owned process(es) survived the quit`)
  return { evidence: { exit: quit.exit, appShutdownCleanAudit: true, leftoverProcesses: 0 } }
}

/**
 * Run the whole scenario, recording one step per id of SETTINGS_HIG_STEPS.
 * @param {{ report: any, launch: () => Promise<any>, onSession: (session: any) => void, platform?: string }} args
 * `launch` starts one instance (the caller owns guards and cleanup); `onSession` hands each new session to the caller's cleanup.
 */
export async function runSettingsHigScenario({ report, launch, onSession, platform = process.platform }) {
  const ctx = {}
  let session = null
  const start = async () => {
    session = await launch()
    onSession(session)
    return session
  }
  const dependent = (id, run) => async () => dependentOutcome(report.steps, id) ?? run()

  await runStep(report, 'launch-and-renderer-ready', async () => {
    await start()
    return {
      evidence: {
        pid: session.pid,
        rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready'),
        cdpConnected: Boolean(session.page),
        captureFileSourceAudit: session.audit().some((record) => record.event === 'qa.capture.file_source')
      }
    }
  })
  const launched = { requires: ['launch-and-renderer-ready'] }
  const opened = { requires: ['launch-and-renderer-ready', 'settings-shortcut-opens'] }
  await runStep(report, 'settings-shortcut-opens', () => settingsShortcutOpens(session, { platform }), launched)
  await runStep(report, 'settings-toggle-applies-without-save', () => toggleAppliesWithoutSave(session, ctx), opened)
  await runStep(report, 'settings-confirm-escape-cancels', () => confirmEscapeCancels(session), opened)
  await runStep(
    report,
    'settings-audio-no-mic-request',
    () => audioPaneMakesNoMicRequest(session, { platform }),
    opened
  )
  ctx.lastPane = 'ai' // the endpoint step ends on Settings > AI, the last pane viewed before the quit
  await runStep(report, 'settings-endpoint-inline-validation', () => endpointInlineValidation(session, ctx), opened)
  await runStep(report, 'clean-quit', () => cleanQuit(session), launched)
  await runStep(
    report,
    'relaunch',
    async () => {
      await start()
      return {
        evidence: {
          pid: session.pid,
          rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready')
        }
      }
    },
    { requires: ['clean-quit'] }
  )
  const relaunched = { requires: ['relaunch'] }
  await runStep(
    report,
    'settings-last-pane-restored',
    dependent('settings-endpoint-inline-validation', () => lastPaneRestored(session, ctx, { platform })),
    relaunched
  )
  await runStep(
    report,
    'settings-endpoint-unchanged-after-relaunch',
    dependent('settings-endpoint-inline-validation', () => endpointUnchangedAfterRelaunch(session, ctx)),
    relaunched
  )
  await runStep(
    report,
    'settings-toggle-persisted-after-relaunch',
    dependent('settings-toggle-applies-without-save', () => togglePersistedAfterRelaunch(session, ctx)),
    relaunched
  )
  await runStep(report, 'final-quit', () => cleanQuit(session), relaunched)
}
