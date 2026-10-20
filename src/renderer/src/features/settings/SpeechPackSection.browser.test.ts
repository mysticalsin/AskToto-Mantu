import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import type {
  SpeechPackActionRequest,
  SpeechPackActionResult,
  SpeechPackComponentSnapshot,
  SpeechPackProgress,
  SpeechPackSnapshot
} from '@shared/speech-pack'

const HARNESS_ID = '\0speech-pack-section-harness'
const profileMarker = Buffer.from('{"schema":1,"profile":"full"}\n')
const packageInventoryPayload = {
  schema: 1,
  profile: 'full',
  platform: 'win32',
  arch: 'x64',
  appVersion: '2.0.0',
  electronVersion: '43.6.0',
  sourceCommit: 'a'.repeat(40),
  coreFiles: [
    {
      path: 'speech-pack-profile.json',
      bytes: profileMarker.byteLength,
      sha256: createHash('sha256').update(profileMarker).digest('hex')
    }
  ]
}
// Mirrors package-contract.ts inventoryIdentity over a valid compiled-full inventory.
const PROFILE_ID = createHash('sha256').update(JSON.stringify(packageInventoryPayload), 'utf8').digest('hex')
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SpeechPackSection } from ${modulePath('features/settings/SpeechPackSection.tsx')}

const config = window.__speechPackConfig
const listeners = new Set()
const state = {
  snapshot: config.snapshot,
  selectedEngine: config.selectedEngine,
  statusFailure: config.statusFailure,
  actionResult: config.actionResult || { ok: true },
  planResult: config.planResult || null,
  installResult: config.installResult || { ok: true },
  statusCalls: 0,
  actionRequests: [],
  planRequests: [],
  installRequests: [],
  pendingStatus: [],
  holdStatus: false,
  unsubscribeCalls: 0
}
const bridge = {
  speechPackState: () => {
    state.statusCalls++
    if (state.statusFailure) return Promise.reject(new Error(state.statusFailure))
    if (state.holdStatus) return new Promise((resolve) => state.pendingStatus.push(resolve))
    return Promise.resolve(state.snapshot)
  },
  speechPackAction: (request) => {
    state.actionRequests.push(request)
    return Promise.resolve(state.actionResult)
  },
  speechPackPlanPreview: (request) => {
    state.planRequests.push(request)
    return Promise.resolve(state.planResult || {
      ok: true,
      plan: {
        planId: '00000000-0000-4000-8000-000000000001',
        action: request.action,
        feature: 'asr',
        selectedComponent: request.componentId,
        missingComponents: [{
          componentId: request.componentId,
          manifestIdentity: request.manifestIdentity,
          downloadBytes: 2000000,
          storageBytes: 3000000,
          license: 'Example license',
          sourceHost: 'models.example.test'
        }],
        totalDownloadBytes: 2000000,
        totalStorageBytes: 3000000,
        profile: 'full',
        profileIdentity: '${PROFILE_ID}'
      }
    })
  },
  speechPackInstallWithPlan: (request) => {
    state.installRequests.push(request)
    return Promise.resolve(state.installResult)
  },
  onSpeechPackProgress: (callback) => {
    listeners.add(callback)
    return () => {
      state.unsubscribeCalls++
      listeners.delete(callback)
    }
  }
}
const root = createRoot(document.getElementById('root'))
const render = () => flushSync(() => root.render(createElement(SpeechPackSection, {
  bridge,
  selectedEngine: state.selectedEngine
})))
window.__speechPack = {
  inspect: () => ({
    statusCalls: state.statusCalls,
    actionRequests: [...state.actionRequests],
    planRequests: [...state.planRequests],
    installRequests: [...state.installRequests],
    pendingStatusCount: state.pendingStatus.length,
    listenerCount: listeners.size,
    unsubscribeCalls: state.unsubscribeCalls
  }),
  update: (snapshot, selectedEngine) => {
    state.snapshot = snapshot
    state.selectedEngine = selectedEngine
    render()
  },
  emit: (progress) => listeners.forEach((listener) => listener(progress)),
  holdStatus: (hold) => {
    state.holdStatus = hold
  },
  resolveStatus: () => {
    for (const resolve of state.pendingStatus.splice(0)) resolve(state.snapshot)
    state.holdStatus = false
  },
  unmount: () => flushSync(() => root.unmount())
}
render()
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
        name: 'speech-pack-section-harness',
        resolveId: (id) => (id === HARNESS_ID ? id : null),
        load: (id) => (id === HARNESS_ID ? HARNESS : null)
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

const WHISPER = 'asr.whisper-base-q8'
const PARAKEET = 'asr.parakeet-tdt-0.6b-v3-int8'
const WHISPER_ID = 'a'.repeat(64)
const PARAKEET_ID = 'b'.repeat(64)

function component(
  componentId: SpeechPackComponentSnapshot['componentId'],
  manifestIdentity: string,
  state: SpeechPackComponentSnapshot['state']
): SpeechPackComponentSnapshot {
  const unavailable = state === 'not-configured'
  return {
    componentId,
    manifestIdentity,
    version: 'test-v1',
    state,
    downloadBytes: 2_000_000,
    installedBytes: 1_000_000,
    sourceHost: unavailable ? null : 'models.example.test',
    integrity: state === 'ready' ? 'freshly-hash-verified-and-self-tested' : 'not-verified'
  }
}

function snapshot(
  options: {
    engine?: SpeechPackSnapshot['selectedEngine']
    whisperState?: SpeechPackComponentSnapshot['state']
    parakeetState?: SpeechPackComponentSnapshot['state']
    featureEnabled?: boolean
    readiness?:
      | 'ready'
      | 'model-needed'
      | 'runtime-needed'
      | 'not-configured'
      | 'incompatible'
      | 'repair-needed'
      | 'unavailable'
  } = {}
): SpeechPackSnapshot & {
  packageProfile: {
    status: 'verified'
    profile: 'full'
    identity: typeof PROFILE_ID
    platform: 'win32'
    arch: 'x64'
    reason: null
  }
  engineReadiness: {
    engine: 'whisper' | 'parakeet' | 'apple'
    state: NonNullable<typeof options.readiness>
    modelComponentId: SpeechPackComponentSnapshot['componentId'] | null
    runtimeComponentIds: string[]
  }
  optionalRuntimeReadiness: {
    speakerEmbedding: 'ready' | 'not-configured' | 'incompatible'
    localLlm: 'ready' | 'not-configured' | 'incompatible'
  }
} {
  const engine = options.engine ?? 'whisper'
  const selectedComponent = engine === 'whisper' ? WHISPER : engine === 'parakeet' ? PARAKEET : null
  const selectedState = engine === 'whisper' ? options.whisperState : options.parakeetState
  return {
    featureEnabled: options.featureEnabled ?? true,
    profile: 'full',
    profileError: null,
    selectedEngine: engine,
    selectedComponent,
    packageProfile: {
      status: 'verified',
      profile: 'full',
      identity: PROFILE_ID,
      platform: 'win32',
      arch: 'x64',
      reason: null
    },
    components: [
      component(WHISPER, WHISPER_ID, options.whisperState ?? 'not-installed'),
      component(PARAKEET, PARAKEET_ID, options.parakeetState ?? 'not-installed')
    ],
    progress: null,
    engineReadiness: {
      engine,
      state:
        options.readiness ??
        (selectedState === 'not-configured' ? 'not-configured' : selectedState === 'ready' ? 'ready' : 'model-needed'),
      modelComponentId: selectedComponent,
      runtimeComponentIds: []
    },
    optionalRuntimeReadiness: { speakerEmbedding: 'not-configured', localLlm: 'not-configured' }
  }
}

type HarnessConfig = {
  snapshot: SpeechPackSnapshot
  selectedEngine: SpeechPackSnapshot['selectedEngine']
  statusFailure?: string
  actionResult?: SpeechPackActionResult
  planResult?: unknown
  installResult?: SpeechPackActionResult
}

type HarnessStats = {
  statusCalls: number
  actionRequests: SpeechPackActionRequest[]
  planRequests: { componentId: string; manifestIdentity: string; action: 'install' | 'repair' }[]
  installRequests: { planId: string; action: 'install' | 'repair' }[]
  pendingStatusCount: number
  listenerCount: number
  unsubscribeCalls: number
}

declare global {
  interface Window {
    __speechPackConfig: HarnessConfig
    __speechPack: {
      inspect(): HarnessStats
      update(snapshot: SpeechPackSnapshot, selectedEngine: SpeechPackSnapshot['selectedEngine']): void
      emit(progress: SpeechPackProgress): void
      holdStatus(hold: boolean): void
      resolveStatus(): void
      unmount(): void
    }
  }
}

describe('SpeechPackSection browser behavior', () => {
  let browser: Browser
  let page: Page
  let bundle: string

  const diagnosticsEnabled = process.env.METIS_BROWSER_TEARDOWN_DIAGNOSTICS === '1'
  const contextIds = new WeakMap<BrowserContext, string>()
  const pageIds = new WeakMap<Page, string>()
  const observedContexts = new WeakSet<BrowserContext>()
  const observedPages = new WeakSet<Page>()
  const closedContexts = new WeakSet<BrowserContext>()
  let nextContextId = 1
  let nextPageId = 1
  let snapshotCaptureFailures = 0

  const contextId = (context: BrowserContext): string => {
    let id = contextIds.get(context)
    if (!id) {
      id = `context-${nextContextId++}`
      contextIds.set(context, id)
    }
    return id
  }

  const pageId = (targetPage: Page): string => {
    let id = pageIds.get(targetPage)
    if (!id) {
      id = `page-${nextPageId++}`
      pageIds.set(targetPage, id)
    }
    return id
  }

  const recordLifecycle = (stage: string, observedPage?: Page): void => {
    if (!diagnosticsEnabled) return

    try {
      const contexts = browser?.contexts() ?? []
      const contextState = contexts.map((context) => {
        const pages = context.pages()
        return {
          id: contextId(context),
          closed: closedContexts.has(context),
          pageCount: pages.length,
          pages: pages.map((ownedPage) => ({ id: pageId(ownedPage), closed: ownedPage.isClosed() }))
        }
      })
      const observedContext = observedPage?.context()
      const observedPages = observedContext?.pages() ?? []
      const observedState =
        observedPage && observedContext
          ? {
              id: pageId(observedPage),
              closed: observedPage.isClosed(),
              contextId: contextId(observedContext),
              contextClosed: closedContexts.has(observedContext),
              contextPageCount: observedPages.length,
              contextPages: observedPages.map((ownedPage) => ({ id: pageId(ownedPage), closed: ownedPage.isClosed() }))
            }
          : null

      process.stderr.write(
        `METIS_BROWSER_TEARDOWN_DIAGNOSTIC ${JSON.stringify({
          stage,
          monotonicNs: process.hrtime.bigint().toString(),
          browserConnected: browser?.isConnected() ?? null,
          contextCount: contexts.length,
          contexts: contextState,
          observedPage: observedState,
          priorSnapshotCaptureFailures: snapshotCaptureFailures
        })}\n`
      )
    } catch {
      snapshotCaptureFailures += 1
      try {
        process.stderr.write(
          `METIS_BROWSER_TEARDOWN_DIAGNOSTIC ${JSON.stringify({
            stage: 'snapshot-capture-failed',
            atStage: stage,
            monotonicNs: process.hrtime.bigint().toString(),
            snapshotCaptureFailures
          })}\n`
        )
      } catch {
        // Diagnostics must not replace a browser lifecycle result.
      }
    }
  }

  const observeOwnedPage = (ownedPage: Page): void => {
    if (!diagnosticsEnabled) return

    const context = ownedPage.context()
    if (!observedPages.has(ownedPage)) {
      observedPages.add(ownedPage)
      ownedPage.once('close', () => recordLifecycle('page-close-event', ownedPage))
    }
    if (!observedContexts.has(context)) {
      observedContexts.add(context)
      context.once('close', () => {
        closedContexts.add(context)
        recordLifecycle('context-close-event', ownedPage)
      })
    }
  }

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    if (diagnosticsEnabled) {
      browser.once('disconnected', () => recordLifecycle('browser-disconnected'))
      recordLifecycle('browser-launch-completed')
    }
  }, 120_000)

  beforeEach(async () => {
    page = await browser.newPage()
    observeOwnedPage(page)
    recordLifecycle('page-allocated', page)
  })

  afterEach(async () => {
    recordLifecycle('page-close-start', page)
    try {
      await page?.close()
      recordLifecycle('page-close-settled', page)
    } catch (error) {
      recordLifecycle('page-close-rejected', page)
      throw error
    }
  })

  afterAll(async () => {
    recordLifecycle('browser-close-start')
    try {
      await browser?.close()
      recordLifecycle('browser-close-settled')
    } catch (error) {
      recordLifecycle('browser-close-rejected')
      throw error
    }
  })

  async function mount(config: HarnessConfig): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate((value) => {
      window.__speechPackConfig = value
    }, config)
    await page.addScriptTag({ content: bundle })
    await page.getByRole('heading', { name: 'On-device speech model' }).waitFor()
  }

  const inspect = (): Promise<HarnessStats> => page.evaluate(() => window.__speechPack.inspect())

  it('reads and subscribes without starting a download, follows progress, and requires review plus confirmation', async () => {
    await mount({ snapshot: snapshot(), selectedEngine: 'whisper' })
    await page.getByText('Whisper base · Model needed').waitFor({ state: 'visible' })
    expect(await inspect()).toMatchObject({ statusCalls: 1, listenerCount: 1, actionRequests: [] })

    await page.evaluate(() =>
      window.__speechPack.emit({
        componentId: 'asr.whisper-base-q8',
        manifestIdentity: 'f'.repeat(64),
        bytesDone: 400_000,
        bytesTotal: 2_000_000,
        state: 'downloading'
      })
    )
    expect(await page.getByRole('progressbar', { name: 'Speech model download progress' }).count()).toBe(0)
    await page.getByText('Whisper base · Model needed').waitFor({ state: 'visible' })

    await page.evaluate(() =>
      window.__speechPack.emit({
        componentId: 'asr.whisper-base-q8',
        manifestIdentity: 'a'.repeat(64),
        bytesDone: 400_000,
        bytesTotal: 2_000_000,
        state: 'downloading'
      })
    )
    await page.getByText('Whisper base · Downloading').waitFor({ state: 'visible' })
    const progressValue = await page
      .getByRole('progressbar', { name: 'Speech model download progress' })
      .getAttribute('value')
    expect(progressValue).toBe('400000')
    expect((await inspect()).actionRequests).toEqual([])

    await page.evaluate((next) => window.__speechPack.update(next, 'parakeet'), snapshot({ engine: 'parakeet' }))
    await page.getByText('Parakeet · Model needed').waitFor({ state: 'visible' })
    expect(await inspect()).toMatchObject({ statusCalls: 2, listenerCount: 1, unsubscribeCalls: 1, actionRequests: [] })
    await page.getByRole('button', { name: 'Review install' }).click()
    const reviewedPlan = page.getByText('Review this optional install').locator('..')
    await reviewedPlan.waitFor({ state: 'visible' })
    const planSummary = reviewedPlan.locator('p').nth(1)
    await planSummary.waitFor({ state: 'visible' })
    expect((await planSummary.textContent())?.replace(/\s+/g, ' ').trim()).toBe('2 MB download · 3 MB storage')
    expect((await inspect()).planRequests).toEqual([
      { componentId: PARAKEET, action: 'install', manifestIdentity: PARAKEET_ID }
    ])
    await page.getByRole('button', { name: 'Install selected components' }).click()
    await page.waitForFunction(() => window.__speechPack.inspect().installRequests.length === 1)
    expect((await inspect()).installRequests).toEqual([
      { planId: '00000000-0000-4000-8000-000000000001', action: 'install' }
    ])
    expect((await inspect()).actionRequests).toEqual([])
  })

  it('keeps unavailable, disabled, and ready controls consistent with the live snapshot', async () => {
    await mount({
      snapshot: snapshot({ whisperState: 'not-configured', featureEnabled: false }),
      selectedEngine: 'whisper'
    })
    await page.getByText('A trusted download source is not configured for this pack yet.').waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Review install' }).count()).toBe(0)
    expect((await inspect()).actionRequests).toEqual([])

    await page.evaluate(
      (next) => window.__speechPack.update(next, 'parakeet'),
      snapshot({ engine: 'parakeet', featureEnabled: false })
    )
    expect(await page.getByRole('button', { name: 'Review install' }).isDisabled()).toBe(true)
    expect((await inspect()).actionRequests).toEqual([])

    await page.evaluate((next) => window.__speechPack.update(next, 'whisper'), snapshot({ whisperState: 'ready' }))
    await page.getByText('Files and model test passed.').waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Review repair' }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: 'Review repair' }).click()
    await page.getByRole('button', { name: 'Repair selected components' }).click()
    await page.waitForFunction(() => window.__speechPack.inspect().installRequests.length === 1)
    expect((await inspect()).installRequests).toEqual([
      { planId: '00000000-0000-4000-8000-000000000001', action: 'repair' }
    ])
  })

  it('shows engine runtime readiness and only reviews a model-bound plan when the engine can be provisioned', async () => {
    await mount({
      snapshot: snapshot({ whisperState: 'ready', readiness: 'runtime-needed' }),
      selectedEngine: 'whisper'
    })
    await page.getByText('Whisper base · Runtime needed').waitFor({ state: 'visible' })
    await page.getByText('The selected model is present, but its compatible local runtime is missing.').waitFor()
    await page.getByRole('button', { name: 'Review repair' }).click()
    expect((await inspect()).planRequests).toEqual([
      { componentId: WHISPER, action: 'repair', manifestIdentity: WHISPER_ID }
    ])

    await page.evaluate((next) => window.__speechPack.update(next, 'parakeet'), snapshot({ engine: 'parakeet' }))
    await page.getByText('Parakeet · Model needed').waitFor({ state: 'visible' })
    await page.evaluate(
      (next) => window.__speechPack.update(next, 'whisper'),
      snapshot({ whisperState: 'ready', readiness: 'not-configured' })
    )
    await page.getByText('Whisper base · Runtime not configured').waitFor({ state: 'visible' })
    await page.getByText('An approved runtime package is not configured for this engine yet.').waitFor()
    expect(await page.getByRole('button', { name: 'Review repair' }).count()).toBe(0)
    expect((await inspect()).planRequests).toEqual([
      { componentId: WHISPER, action: 'repair', manifestIdentity: WHISPER_ID }
    ])
  })

  it('hides an old plan immediately while the newly selected engine status is pending', async () => {
    await mount({ snapshot: snapshot({ whisperState: 'ready' }), selectedEngine: 'whisper' })
    await page.getByRole('button', { name: 'Review repair' }).click()
    await page.getByRole('button', { name: 'Repair selected components' }).waitFor({ state: 'visible' })

    await page.evaluate(
      (next) => {
        window.__speechPack.holdStatus(true)
        window.__speechPack.update(next, 'parakeet')
      },
      snapshot({ engine: 'parakeet' })
    )
    await page.getByText('Loading model status…').waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Repair selected components' }).count()).toBe(0)
    expect((await inspect()).installRequests).toEqual([])
    await page.waitForFunction(() => window.__speechPack.inspect().pendingStatusCount === 1)

    await page.evaluate(() => window.__speechPack.resolveStatus())
    await page.getByText('Parakeet · Model needed').waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Repair selected components' }).count()).toBe(0)
  })

  it('shows safe status on bridge failure and a fixed message when plan preview is refused', async () => {
    await mount({ snapshot: snapshot(), selectedEngine: 'whisper', statusFailure: 'private bridge details' })
    await page.getByText('Speech-pack status is unavailable right now.').waitFor({ state: 'visible' })
    expect(await page.getByText('private bridge details').count()).toBe(0)
    expect(await inspect()).toMatchObject({ statusCalls: 1, actionRequests: [] })

    await page.evaluate(() => window.__speechPack.unmount())
    await mount({
      snapshot: snapshot(),
      selectedEngine: 'whisper',
      planResult: { ok: false, reason: 'policy-blocked' }
    })
    await page.getByRole('button', { name: 'Review install' }).click()
    await page.getByRole('status').filter({ hasText: 'Downloads are disabled by your organization.' }).waitFor()
    expect(await page.getByRole('status').textContent()).toBe('Downloads are disabled by your organization.')
    expect((await inspect()).planRequests).toEqual([
      { componentId: WHISPER, action: 'install', manifestIdentity: WHISPER_ID }
    ])
    expect((await inspect()).installRequests).toEqual([])
  })

  it('refuses a plan whose package identity differs from the compiled full profile', async () => {
    await mount({
      snapshot: snapshot(),
      selectedEngine: 'whisper',
      planResult: {
        ok: true,
        plan: {
          planId: '00000000-0000-4000-8000-000000000001',
          action: 'install',
          feature: 'asr',
          selectedComponent: WHISPER,
          missingComponents: [
            {
              componentId: WHISPER,
              manifestIdentity: WHISPER_ID,
              downloadBytes: 2_000_000,
              storageBytes: 3_000_000,
              license: 'Example license',
              sourceHost: 'models.example.test'
            }
          ],
          totalDownloadBytes: 2_000_000,
          totalStorageBytes: 3_000_000,
          profile: 'full',
          profileIdentity: 'd'.repeat(64)
        }
      }
    })
    await page.getByRole('button', { name: 'Review install' }).click()
    await page
      .getByRole('status')
      .filter({ hasText: 'The install plan no longer matches the selected speech component.' })
      .waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Install selected components' }).count()).toBe(0)
    expect((await inspect()).installRequests).toEqual([])
  })

  it('unsubscribes progress listeners on unmount and renders invalid package profiles as repair-required', async () => {
    await mount({
      snapshot: {
        ...snapshot(),
        profile: null,
        profileError: 'invalid-profile',
        packageProfile: {
          status: 'invalid',
          profile: null,
          identity: null,
          platform: null,
          arch: null,
          reason: 'profile-invalid'
        }
      },
      selectedEngine: 'whisper'
    })
    await page
      .getByRole('alert')
      .filter({ hasText: 'Speech-pack settings need repair. Reinstall the official Métis package.' })
      .waitFor()
    expect(await page.getByRole('alert').textContent()).toBe(
      'Speech-pack settings need repair. Reinstall the official Métis package.'
    )
    await page.evaluate(() => window.__speechPack.unmount())
    expect(await inspect()).toMatchObject({ listenerCount: 0, unsubscribeCalls: 1, actionRequests: [] })
  })
})
