/**
 * The packaged History navigation-guard rows (HIST-*, M2-0232, split out by M2-0410). They drive the
 * already-launched app over CDP: switch it to the bar layout, reveal it, seed two synthetic meetings, run
 * every clean and dirty (cancel / discard / save) History entry, then restore the hover layout the RV rows
 * need. See the header of ../packaged-smoke.mjs for why the profile is seeded before launch.
 */
import { attach, findPage, runProcess, sleep, waitForText } from '../lib/app-driver.mjs'
import { isOverlayUrl, parkAndProve } from './smoke-support.mjs'

// The same patch `appearanceSettingsPatch('bar')` (onboarding-appearance.ts) writes when a real user
// picks the bar layout, plus the `persistOnboardingCompletion` fields (onboarding-completion.ts) that
// mark the tour finished — i.e. exactly the durable state of a real user who finished onboarding with
// the bar layout and left auto-hide off. Never a synthetic in-between state.
export const NAVIGATION_GUARD_BOOTSTRAP_PATCH = Object.freeze({
  onboardingDone: true,
  recordingConsent: true,
  overlayLayout: 'bar',
  autoHideOverlay: false
})

export const NAVIGATION_GUARD_SCENARIOS = Object.freeze([
  { id: 'HIST-clean-bar-open', state: 'clean', entry: 'bar-history' },
  { id: 'HIST-clean-settings-open', state: 'clean', entry: 'settings-open-full-history' },
  { id: 'HIST-clean-row-doubleclick', state: 'clean', entry: 'history-row-doubleclick' },
  { id: 'HIST-clean-bottom-open', state: 'clean', entry: 'history-open-button' },
  { id: 'HIST-clean-back', state: 'clean', entry: 'review-back-to-history' },
  { id: 'HIST-clean-recent-meeting', state: 'clean', entry: 'review-recent-meeting' },
  { id: 'HIST-dirty-cancel-bar', state: 'dirty', entry: 'bar-history-cancel' },
  { id: 'HIST-dirty-discard-bar', state: 'dirty', entry: 'bar-history-discard' },
  { id: 'HIST-dirty-save-bar', state: 'dirty', entry: 'bar-history-save' },
  { id: 'HIST-dirty-cancel-settings-open', state: 'dirty', entry: 'settings-open-full-history-cancel' },
  { id: 'HIST-dirty-discard-settings-open', state: 'dirty', entry: 'settings-open-full-history-discard' },
  { id: 'HIST-dirty-save-settings-open', state: 'dirty', entry: 'settings-open-full-history-save' },
  { id: 'HIST-dirty-cancel-back', state: 'dirty', entry: 'review-back-to-history-cancel' },
  { id: 'HIST-dirty-discard-back', state: 'dirty', entry: 'review-back-to-history-discard' },
  { id: 'HIST-dirty-save-back', state: 'dirty', entry: 'review-back-to-history-save' },
  { id: 'HIST-dirty-cancel-recent', state: 'dirty', entry: 'review-recent-meeting-cancel' },
  { id: 'HIST-dirty-discard-recent', state: 'dirty', entry: 'review-recent-meeting-discard' },
  { id: 'HIST-dirty-save-recent', state: 'dirty', entry: 'review-recent-meeting-save' }
])

export function initialNavigationGuardRows() {
  return NAVIGATION_GUARD_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    state: scenario.state,
    entry: scenario.entry,
    status: 'PENDING',
    evidence: null,
    unblock: null
  }))
}

function completeNavigationRow(rows, id, patch) {
  const row = rows.find((entry) => entry.id === id)
  if (row) Object.assign(row, patch)
}

function findOverlayPage(browser, timeout = 15_000) {
  return findPage(browser, (page) => isOverlayUrl(page.url()), 'overlay page not found', timeout, 100)
}

async function withOverlayPage(port, fn) {
  const browser = await attach(`http://127.0.0.1:${port}`, 30_000)
  try {
    const overlay = await findOverlayPage(browser)
    return await fn(overlay, browser)
  } finally {
    await browser.close().catch(() => undefined)
  }
}

async function locatorVisible(locator) {
  return locator.first().isVisible({ timeout: 500 }).catch(() => false)
}

async function ensureNavigationGuardHarnessState(page, browser) {
  const state = await page.evaluate(async (patch) => {
    const before = await window.toto.getSettings()
    const after = await window.toto.setSettings({ ...patch, onboardingDoneAt: Date.now() })
    if (!before.onboardingDone) window.toto.onboardingExit('answer')
    return {
      beforeOnboardingDone: before.onboardingDone,
      afterOnboardingDone: after.onboardingDone,
      overlayLayout: after.overlayLayout,
      autoHideOverlay: after.autoHideOverlay
    }
  }, NAVIGATION_GUARD_BOOTSTRAP_PATCH)
  const activePage = state.beforeOnboardingDone ? page : await findOverlayPage(browser, 30_000)
  await activePage.getByRole('button', { name: 'History' }).first().waitFor({ timeout: 15_000 })
  return { page: activePage, state }
}

async function restoreHoverParkableLayout(page) {
  // RV rows require overlayUsesHover (hide/island) for parked===true evidence on m2.
  await page.evaluate(async () => {
    await window.toto.setSettings({ overlayLayout: 'hide', autoHideOverlay: true })
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ok = await page.evaluate(async () => {
      const settings = await window.toto.getSettings()
      return settings.overlayLayout === 'hide' && settings.autoHideOverlay === true
    })
    if (ok) return
    await sleep(100)
  }
  throw new Error('hover parkable layout was not applied before RV rows')
}

async function settleOverlayForRvRows({ page, executable, env, userData }) {
  await dismissNavigationGuardIfOpen(page)
  await ensureIdleBar(page)
  await restoreHoverParkableLayout(page)
  const parked = await parkAndProve({ executable, env, userData })
  if (parked.error) throw new Error('park-window after navigation guard failed to prove parked===true')
}

async function ensureHistory(page) {
  const search = page.getByLabel('Search past meetings')
  if (await locatorVisible(search)) return

  const backToHistory = page.getByRole('button', { name: /Back to history/ })
  if (await locatorVisible(backToHistory)) {
    await backToHistory.first().click({ timeout: 15_000 })
    await search.waitFor({ timeout: 15_000 })
    return
  }

  await clickHistory(page)
}

async function ensureIdleBar(page) {
  const search = page.getByLabel('Search past meetings')
  if (await locatorVisible(search)) {
    await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
    await search.waitFor({ state: 'hidden', timeout: 15_000 })
    await page.waitForTimeout(450)
    return
  }

  const backToHistory = page.getByRole('button', { name: /Back to history/ })
  if (await locatorVisible(backToHistory)) {
    await backToHistory.first().click({ timeout: 15_000 })
    await search.waitFor({ timeout: 15_000 })
    await ensureIdleBar(page)
  }
}

async function seedNavigationMeetings(page) {
  return page.evaluate(async () => {
    const startedAt = Date.now()
    const first = await window.toto.saveTranscript({
      title: 'Smoke navigation alpha',
      mode: 'meeting',
      startedAt,
      durationMs: 60_000,
      lines: [{ speaker: 'them', text: 'Synthetic alpha navigation meeting.', t: 1 }],
      recap: '## Overview\nSmoke navigation alpha recap.',
      recapStatus: 'complete'
    })
    const second = await window.toto.saveTranscript({
      title: 'Smoke navigation beta',
      mode: 'meeting',
      startedAt: startedAt + 1,
      durationMs: 60_000,
      lines: [{ speaker: 'them', text: 'Synthetic beta navigation meeting.', t: 1 }],
      recap: '## Overview\nSmoke navigation beta recap.',
      recapStatus: 'complete'
    })
    return {
      first: first.path.split(/[\\/]/).pop(),
      second: second.path.split(/[\\/]/).pop()
    }
  })
}

async function clickHistory(page) {
  await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
  await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
}

async function clickHistoryButton(page) {
  await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
}

async function clickSettingsButton(page) {
  await page.getByRole('button', { name: 'Settings' }).first().click({ timeout: 15_000 })
}

async function clickOpenFullHistoryFromSettings(page) {
  await page.getByRole('tab', { name: 'Brain' }).first().click({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Open full history' }).first().click({ timeout: 15_000 })
}

async function openHistoryFromSettings(page) {
  await clickSettingsButton(page)
  await clickOpenFullHistoryFromSettings(page)
  await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
}

async function openMeetingFromHistoryRow(page, title) {
  await ensureHistory(page)
  await page.getByRole('button', { name: new RegExp(title) }).first().dblclick({ timeout: 15_000 })
  await waitForText(page, 'Summary')
}

async function openMeetingFromHistoryButton(page, title) {
  await ensureHistory(page)
  await page.getByRole('button', { name: new RegExp(title) }).first().click({ timeout: 15_000 })
  await page.getByRole('button', { name: /^Open/ }).first().click({ timeout: 15_000 })
  await waitForText(page, 'Summary')
}

async function makeRecapDirty(page, suffix) {
  await page.getByRole('button', { name: /Edit/ }).first().click({ timeout: 15_000 })
  const editor = page.getByLabel('Edit meeting notes')
  await editor.waitFor({ timeout: 15_000 })
  await editor.fill(`## Overview\n${suffix}`)
}

async function expectGuard(page) {
  await page.getByRole('dialog', { name: 'Save recap changes?' }).waitFor({ timeout: 15_000 })
}

async function returnToHistoryFromReview(page) {
  await page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 })
  await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
}

async function cancelRecapEdit(page) {
  await page.getByRole('button', { name: 'Cancel' }).first().click({ timeout: 15_000 })
  await page.getByRole('button', { name: /Edit/ }).first().waitFor({ timeout: 15_000 })
}

async function openDirtyReview(page, title, suffix) {
  await openMeetingFromHistoryRow(page, title)
  await makeRecapDirty(page, suffix)
}

async function assertDirtyDraft(page, suffix) {
  await page.getByLabel('Edit meeting notes').waitFor({ timeout: 15_000 })
  const value = await page.getByLabel('Edit meeting notes').inputValue()
  if (!value.includes(suffix)) throw new Error('cancel did not preserve dirty recap draft')
}

async function expectSavedRecap(page, file, suffix) {
  const readBack = await page.evaluate(async (savedFile) => window.toto.recallRead(savedFile), file)
  if (!readBack.ok || !readBack.recap.includes(suffix)) {
    throw new Error('save decision did not persist the dirty recap before navigation')
  }
}

async function dismissNavigationGuardIfOpen(page) {
  const dialog = page.getByRole('dialog', { name: 'Save recap changes?' })
  if (!(await locatorVisible(dialog))) return
  await dialog.getByRole('button', { name: 'Cancel' }).first().click({ timeout: 15_000 })
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })
}

async function waitForNavigationGuardClosed(page) {
  await page.getByRole('dialog', { name: 'Save recap changes?' }).waitFor({ state: 'hidden', timeout: 15_000 })
}

async function chooseDirtyHistoryNavigation(page, choice, trigger) {
  await dismissNavigationGuardIfOpen(page)
  // Bar History ignores clicks inside a 400ms toggle debounce; settle after prior History traffic.
  await page.waitForTimeout(450)
  await trigger()
  await expectGuard(page)
  const dialog = page.getByRole('dialog', { name: 'Save recap changes?' })
  await dialog.getByRole('button', { name: choice, exact: true }).click({ timeout: 15_000 })
  await waitForNavigationGuardClosed(page)
}

async function runNavigationStep(rows, id, fn) {
  try {
    const evidence = await fn()
    completeNavigationRow(rows, id, { status: 'PASS', evidence: evidence ?? { observed: true }, unblock: null })
  } catch (err) {
    completeNavigationRow(rows, id, {
      status: 'FAIL',
      evidence: null,
      unblock: `Inspect the packaged-smoke artifact; navigation guard scenario failed: ${err?.message ?? String(err)}`
    })
  }
}

async function revealNavigationSurface({ executable, env, page }) {
  const result = await runProcess(executable, ['--metis-smoke-reopen=tray-show'], 10_000, { env })
  if (result.error) throw new Error('smoke tray-show reveal probe failed before navigation')
  await page.getByRole('button', { name: 'History' }).first().waitFor({ timeout: 15_000 })
}

export async function runPackagedNavigationGuardRows({ port, rows, executable, env }) {
  await withOverlayPage(port, async (initialPage, browser) => {
    const ready = await ensureNavigationGuardHarnessState(initialPage, browser)
    const page = ready.page
    await revealNavigationSurface({ executable, env, page })
    const seeded = await seedNavigationMeetings(page)

    await runNavigationStep(rows, 'HIST-clean-bar-open', async () => {
      await ensureIdleBar(page)
      await clickHistory(page)
      return { seededMeetings: 2, guardVisible: false, harnessState: ready.state }
    })

    await runNavigationStep(rows, 'HIST-clean-settings-open', async () => {
      await openHistoryFromSettings(page)
      return { returnedToHistory: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-row-doubleclick', async () => {
      await openMeetingFromHistoryRow(page, 'Smoke navigation alpha')
      return { openedReview: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-bottom-open', async () => {
      await returnToHistoryFromReview(page)
      await openMeetingFromHistoryButton(page, 'Smoke navigation alpha')
      return { openedReview: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-back', async () => {
      await returnToHistoryFromReview(page)
      return { returnedToHistory: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-clean-recent-meeting', async () => {
      await openMeetingFromHistoryRow(page, 'Smoke navigation alpha')
      await page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 })
      await waitForText(page, 'Smoke navigation beta')
      await returnToHistoryFromReview(page)
      return { openedRecentMeeting: true, guardVisible: false }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-bar', async () => {
      const suffix = 'Cancel keeps this smoke edit from Bar History.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => clickHistoryButton(page))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'bar-history', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-bar', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Bar History.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => clickHistoryButton(page))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      return { decision: 'discard', entry: 'bar-history', returnedToHistory: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-bar', async () => {
      const suffix = 'Saved by Bar History navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => clickHistoryButton(page))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      await expectSavedRecap(page, seeded.first, suffix)
      return { decision: 'save', entry: 'bar-history', persistedBeforeNavigation: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-settings-open', async () => {
      const suffix = 'Cancel keeps this smoke edit from Settings Open full history.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => clickSettingsButton(page))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'settings-open-full-history', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-settings-open', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Settings Open full history.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => clickSettingsButton(page))
      await clickOpenFullHistoryFromSettings(page)
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      return { decision: 'discard', entry: 'settings-open-full-history', returnedToHistory: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-settings-open', async () => {
      const suffix = 'Saved by Settings Open full history navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => clickSettingsButton(page))
      await clickOpenFullHistoryFromSettings(page)
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      await expectSavedRecap(page, seeded.first, suffix)
      return { decision: 'save', entry: 'settings-open-full-history', persistedBeforeNavigation: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-back', async () => {
      const suffix = 'Cancel keeps this smoke edit from Back.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-back', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Back to history.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      return { decision: 'discard', returnedToHistory: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-back', async () => {
      const suffix = 'Saved by Back to history navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await page.getByLabel('Search past meetings').waitFor({ timeout: 15_000 })
      await expectSavedRecap(page, seeded.first, suffix)
      return { decision: 'save', returnedToHistory: true, persistedBeforeNavigation: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-cancel-recent', async () => {
      const suffix = 'Cancel keeps this smoke edit from Recent meetings.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 }))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'review-recent-meeting', draftPreserved: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-discard-recent', async () => {
      await openDirtyReview(page, 'Smoke navigation alpha', 'Discard by Recent meetings.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 }))
      await waitForText(page, 'Smoke navigation beta')
      await returnToHistoryFromReview(page)
      return { decision: 'discard', entry: 'review-recent-meeting', openedTargetMeeting: true }
    })

    await runNavigationStep(rows, 'HIST-dirty-save-recent', async () => {
      const suffix = 'Saved by Recent meetings navigation guard.'
      await openDirtyReview(page, 'Smoke navigation alpha', suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => page.getByRole('button', { name: /Smoke navigation beta/ }).first().click({ timeout: 15_000 }))
      await waitForText(page, 'Smoke navigation beta')
      await expectSavedRecap(page, seeded.first, suffix)
      await returnToHistoryFromReview(page)
      return { decision: 'save', entry: 'review-recent-meeting', persistedBeforeNavigation: true }
    })

    await settleOverlayForRvRows({ page, executable, env, userData: env.ASKTOTO_USERDATA })
  })
}
