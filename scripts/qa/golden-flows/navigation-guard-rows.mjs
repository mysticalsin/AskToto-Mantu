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

export async function withOverlayPage(port, fn) {
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

export function navigationViewReadiness(snapshot, request) {
  if (request.view === 'history') {
    if (snapshot.searchVisible !== true) return { ready: false, reason: 'history search field was not visible' }
    if (snapshot.searchEnabled !== true) return { ready: false, reason: 'history search field was not interactive' }
    if (request.title && snapshot.targetMeetingButtonVisible !== true) {
      return { ready: false, reason: 'target history row was not visible' }
    }
    if (request.title && snapshot.targetMeetingButtonEnabled !== true) {
      return { ready: false, reason: 'target history row was not interactive' }
    }
    return { ready: true, reason: null }
  }

  if (snapshot.backVisible !== true) return { ready: false, reason: 'review back button was not visible' }
  if (snapshot.backEnabled !== true) return { ready: false, reason: 'review back button was not interactive' }
  if (request.title && snapshot.titleVisible !== true) return { ready: false, reason: 'target review was not visible' }
  if (snapshot.guardVisible === true) return { ready: false, reason: 'navigation guard was still open' }
  return { ready: true, reason: null }
}

function navigationSnapshotDiagnostic(snapshot) {
  if (!snapshot) return null
  return {
    searchVisible: snapshot.searchVisible === true,
    searchEnabled: snapshot.searchEnabled === true,
    targetMeetingButtonVisible: snapshot.targetMeetingButtonVisible === true,
    targetMeetingButtonEnabled: snapshot.targetMeetingButtonEnabled === true,
    backVisible: snapshot.backVisible === true,
    backEnabled: snapshot.backEnabled === true,
    titleVisible: snapshot.titleVisible === true,
    guardVisible: snapshot.guardVisible === true
  }
}

export async function readNavigationViewSnapshot(page, request) {
  return page.evaluate(({ title }) => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = window.getComputedStyle(node)
      return style.visibility !== 'hidden' && style.display !== 'none' && node.getClientRects().length > 0
    }
    const enabled = (node) =>
      node instanceof HTMLElement &&
      !node.hasAttribute('disabled') &&
      node.getAttribute('aria-disabled') !== 'true'
    const buttons = Array.from(document.querySelectorAll('button'))
    const buttonMatching = (pattern) =>
      buttons.find((button) => {
        const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`
        return pattern.test(label) && visible(button)
      }) ??
      buttons.find((button) => {
        const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`
        return pattern.test(label)
      }) ?? null
    const targetButton = title
      ? buttons.find((button) => `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.includes(title) && visible(button)) ??
        buttons.find((button) => `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.includes(title)) ??
        null
      : null
    const search = document.querySelector('[aria-label="Search past meetings"]')
    const back = buttonMatching(/Back to history/i)
    const reviewTitle = title ? document.querySelector('[aria-label="Review meeting title"]') : null
    const guard = document.querySelector('[role="dialog"][aria-label="Save recap changes?"]')
    return {
      searchVisible: visible(search),
      searchEnabled: enabled(search),
      targetMeetingButtonVisible: title ? visible(targetButton) : null,
      targetMeetingButtonEnabled: title ? enabled(targetButton) : null,
      backVisible: visible(back),
      backEnabled: enabled(back),
      titleVisible: title ? visible(reviewTitle) && (reviewTitle.textContent ?? '').includes(title) : null,
      guardVisible: visible(guard)
    }
  }, { title: request.title ?? null })
}

export async function waitForNavigationView(page, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  const pollMs = options.pollMs ?? 100
  const wait = options.wait ?? sleep
  const deadline = Date.now() + timeoutMs
  let lastSnapshot = null
  let lastReadError = null

  while (Date.now() < deadline) {
    try {
      lastSnapshot = await readNavigationViewSnapshot(page, request)
      lastReadError = null
      const verdict = navigationViewReadiness(lastSnapshot, request)
      if (verdict.ready) return lastSnapshot
    } catch (err) {
      lastReadError = err
    }
    await wait(pollMs)
  }

  const verdict = lastSnapshot ? navigationViewReadiness(lastSnapshot, request) : null
  const reason = lastReadError
    ? `renderer readiness probe failed: ${lastReadError?.message ?? String(lastReadError)}`
    : verdict?.reason ?? 'renderer readiness probe produced no observation'
  throw new Error(
    `${request.view} view was not reached: ${reason}; readiness=${JSON.stringify(navigationSnapshotDiagnostic(lastSnapshot))}`
  )
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
  if (await locatorVisible(search)) {
    await waitForNavigationView(page, { view: 'history' })
    return
  }

  const backToHistory = page.getByRole('button', { name: /Back to history/ })
  if (await locatorVisible(backToHistory)) {
    await backToHistory.first().click({ timeout: 15_000 })
    await waitForNavigationView(page, { view: 'history' })
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

export function navigationMeetingTitles(label = '') {
  const suffix = label ? ` ${label}` : ''
  return {
    alpha: `Smoke navigation alpha${suffix}`,
    beta: `Smoke navigation beta${suffix}`
  }
}

async function refreshOpenHistoryAfterSeed(page) {
  const search = page.getByLabel('Search past meetings')
  if (!(await locatorVisible(search))) return
  // History's toolbar button has the same debounce as the navigation guard rows; settle after seeding.
  await page.waitForTimeout(450)
  await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
  await search.waitFor({ state: 'hidden', timeout: 15_000 })
  await page.waitForTimeout(450)
  await clickHistory(page)
}

export async function seedNavigationMeetings(page, label = '') {
  const seeded = await page.evaluate(async (titles) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const saveSmokeMeeting = async (payload) => {
      let lastError = null
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          return await window.toto.saveTranscript(payload)
        } catch (err) {
          lastError = err
          const message = err instanceof Error ? err.message : String(err)
          if (!message.includes('Could not save the transcript')) throw err
          await sleep(2_200)
        }
      }
      throw lastError ?? new Error('Could not save the transcript.')
    }
    const startedAt = Date.now()
    const first = await saveSmokeMeeting({
      title: titles.alpha,
      mode: 'meeting',
      startedAt,
      durationMs: 60_000,
      lines: [{ speaker: 'them', text: 'Synthetic alpha navigation meeting.', t: 1 }],
      recap: `## Overview\n${titles.alpha} recap.`,
      recapStatus: 'complete'
    })
    const second = await saveSmokeMeeting({
      title: titles.beta,
      mode: 'meeting',
      startedAt: startedAt + 1,
      durationMs: 60_000,
      lines: [{ speaker: 'them', text: 'Synthetic beta navigation meeting.', t: 1 }],
      recap: `## Overview\n${titles.beta} recap.`,
      recapStatus: 'complete'
    })
    return {
      first: first.path.split(/[\\/]/).pop(),
      second: second.path.split(/[\\/]/).pop(),
      titles
    }
  }, navigationMeetingTitles(label))
  await refreshOpenHistoryAfterSeed(page)
  return seeded
}

async function clickHistory(page) {
  await page.getByRole('button', { name: 'History' }).first().click({ timeout: 15_000 })
  await waitForNavigationView(page, { view: 'history' })
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
  await waitForNavigationView(page, { view: 'history' })
}

async function openMeetingFromHistoryRow(page, title) {
  await ensureHistory(page)
  const row = page.getByRole('button', { name: new RegExp(title) }).first()
  await row.waitFor({ timeout: 15_000 })
  await row.dblclick({ timeout: 15_000 })
  await waitForText(page, 'Summary')
}

async function openMeetingFromHistoryButton(page, title) {
  await ensureHistory(page)
  const row = page.getByRole('button', { name: new RegExp(title) }).first()
  await row.waitFor({ timeout: 15_000 })
  await row.click({ timeout: 15_000 })
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

export async function returnToHistoryFromReview(page, options = {}) {
  if (options.reviewTitle) await waitForNavigationView(page, { view: 'review', title: options.reviewTitle })
  await page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 })
  await waitForNavigationView(page, { view: 'history', title: options.historyTitle })
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

async function runNavigationStep(rows, id, fn, recover) {
  try {
    const evidence = await fn()
    completeNavigationRow(rows, id, { status: 'PASS', evidence: evidence ?? { observed: true }, unblock: null })
  } catch (err) {
    completeNavigationRow(rows, id, {
      status: 'FAIL',
      evidence: null,
      unblock: `Inspect the packaged-smoke artifact; navigation guard scenario failed: ${err?.message ?? String(err)}`
    })
    await recover?.().catch(() => undefined)
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
    await seedNavigationMeetings(page)
    const recoverNavigationGuardHarness = async () => {
      await dismissNavigationGuardIfOpen(page)
      const editor = page.getByLabel('Edit meeting notes')
      if (await locatorVisible(editor)) await cancelRecapEdit(page)
      await ensureHistory(page)
    }

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
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty cancel bar')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => clickHistoryButton(page))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'bar-history', draftPreserved: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-discard-bar', async () => {
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty discard bar')
      await openDirtyReview(page, rowSeeded.titles.alpha, 'Discard by Bar History.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => clickHistoryButton(page))
      await waitForNavigationView(page, { view: 'history', title: rowSeeded.titles.alpha })
      return { decision: 'discard', entry: 'bar-history', returnedToHistory: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-save-bar', async () => {
      const suffix = 'Saved by Bar History navigation guard.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty save bar')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => clickHistoryButton(page))
      await waitForNavigationView(page, { view: 'history', title: rowSeeded.titles.alpha })
      await expectSavedRecap(page, rowSeeded.first, suffix)
      return { decision: 'save', entry: 'bar-history', persistedBeforeNavigation: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-cancel-settings-open', async () => {
      const suffix = 'Cancel keeps this smoke edit from Settings Open full history.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty cancel settings')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => clickSettingsButton(page))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'settings-open-full-history', draftPreserved: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-discard-settings-open', async () => {
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty discard settings')
      await openDirtyReview(page, rowSeeded.titles.alpha, 'Discard by Settings Open full history.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => clickSettingsButton(page))
      await clickOpenFullHistoryFromSettings(page)
      await waitForNavigationView(page, { view: 'history', title: rowSeeded.titles.alpha })
      return { decision: 'discard', entry: 'settings-open-full-history', returnedToHistory: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-save-settings-open', async () => {
      const suffix = 'Saved by Settings Open full history navigation guard.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty save settings')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => clickSettingsButton(page))
      await clickOpenFullHistoryFromSettings(page)
      await waitForNavigationView(page, { view: 'history', title: rowSeeded.titles.alpha })
      await expectSavedRecap(page, rowSeeded.first, suffix)
      return { decision: 'save', entry: 'settings-open-full-history', persistedBeforeNavigation: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-cancel-back', async () => {
      const suffix = 'Cancel keeps this smoke edit from Back.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty cancel back')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', draftPreserved: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-discard-back', async () => {
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty discard back')
      await openDirtyReview(page, rowSeeded.titles.alpha, 'Discard by Back to history.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await waitForNavigationView(page, { view: 'history', title: rowSeeded.titles.alpha })
      return { decision: 'discard', returnedToHistory: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-save-back', async () => {
      const suffix = 'Saved by Back to history navigation guard.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty save back')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => page.getByRole('button', { name: /Back to history/ }).first().click({ timeout: 15_000 }))
      await waitForNavigationView(page, { view: 'history', title: rowSeeded.titles.alpha })
      await expectSavedRecap(page, rowSeeded.first, suffix)
      return { decision: 'save', returnedToHistory: true, persistedBeforeNavigation: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-cancel-recent', async () => {
      const suffix = 'Cancel keeps this smoke edit from Recent meetings.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty cancel recent')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Cancel', () => page.getByRole('button', { name: new RegExp(rowSeeded.titles.beta) }).first().click({ timeout: 15_000 }))
      await assertDirtyDraft(page, suffix)
      await cancelRecapEdit(page)
      await returnToHistoryFromReview(page)
      return { decision: 'cancel', entry: 'review-recent-meeting', draftPreserved: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-discard-recent', async () => {
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty discard recent')
      await openDirtyReview(page, rowSeeded.titles.alpha, 'Discard by Recent meetings.')
      await chooseDirtyHistoryNavigation(page, 'Discard', () => page.getByRole('button', { name: new RegExp(rowSeeded.titles.beta) }).first().click({ timeout: 15_000 }))
      await waitForNavigationView(page, { view: 'review', title: rowSeeded.titles.beta })
      await returnToHistoryFromReview(page, { reviewTitle: rowSeeded.titles.beta, historyTitle: rowSeeded.titles.alpha })
      return { decision: 'discard', entry: 'review-recent-meeting', openedTargetMeeting: true }
    }, recoverNavigationGuardHarness)

    await runNavigationStep(rows, 'HIST-dirty-save-recent', async () => {
      const suffix = 'Saved by Recent meetings navigation guard.'
      const rowSeeded = await seedNavigationMeetings(page, 'HIST dirty save recent')
      await openDirtyReview(page, rowSeeded.titles.alpha, suffix)
      await chooseDirtyHistoryNavigation(page, 'Save', () => page.getByRole('button', { name: new RegExp(rowSeeded.titles.beta) }).first().click({ timeout: 15_000 }))
      await waitForNavigationView(page, { view: 'review', title: rowSeeded.titles.beta })
      await expectSavedRecap(page, rowSeeded.first, suffix)
      await returnToHistoryFromReview(page, { reviewTitle: rowSeeded.titles.beta, historyTitle: rowSeeded.titles.alpha })
      return { decision: 'save', entry: 'review-recent-meeting', persistedBeforeNavigation: true }
    }, recoverNavigationGuardHarness)

    await settleOverlayForRvRows({ page, executable, env, userData: env.ASKTOTO_USERDATA })
  })
}
