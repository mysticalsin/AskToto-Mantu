import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, IPC } from '@shared/ipc'
import { createQuitTrace } from './lifecycle/quit-trace'
import { registerOptionalModelProvisioningIpc, startSpeechPackDesktop } from './speech-pack-bootstrap'
import { asrModelDownloadState, isHighTierAsrModelReady } from './asr-model-download'

const mocks = vi.hoisted(() => {
  const service = {
    policyChanged: vi.fn(),
    selectionChanged: vi.fn(),
    captureActivityChanged: vi.fn(),
    shutdown: vi.fn(async () => {})
  }
  const unregister = vi.fn()
  return {
    service,
    unregister,
    createSpeechPackService: vi.fn((_options: unknown) => service),
    createPackageRuntimeContractProvider: vi.fn(() => async () => ({
      status: 'legacy-full',
      profile: 'full',
      inventory: null
    })),
    configurePackageRuntimeContractProvider: vi.fn(),
    registerSpeechPackIpc: vi.fn(() => unregister),
    getPackageRuntimeContract: vi.fn(),
    readSettingsAtAuthorityBoundary: vi.fn(),
    getSpeechPolicyAuthorityStatus: vi.fn(),
    asrModelPath: vi.fn<(_name: string) => string>(() => {
      throw new Error('Refused ASR request reached model-path I/O')
    }),
    asrFetch: vi.fn<(...args: unknown[]) => Promise<Response>>(() => {
      throw new Error('Refused ASR request reached network I/O')
    }),
    asrFixture: {
      id: 'fixture/asr-provisioning',
      revision: '0123456789012345678901234567890123456789',
      files: [
        { path: 'model.bin', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }
      ]
    }
  }
})
// Only this composed-behavior suite substitutes a tiny manifest; manifest-contract tests keep real pins.
vi.mock('./asr-model-manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./asr-model-manifest')>()),
  HIGH_TIER_ASR_MODEL: mocks.asrFixture
}))
vi.mock('./features/components', () => ({
  createSpeechPackService: mocks.createSpeechPackService,
  createPackageRuntimeContractProvider: mocks.createPackageRuntimeContractProvider,
  configurePackageRuntimeContractProvider: mocks.configurePackageRuntimeContractProvider
}))
vi.mock('./ipc/speech-pack-ipc', () => ({ registerSpeechPackIpc: mocks.registerSpeechPackIpc }))
vi.mock('./features/components/speech-pack/package-runtime-state', () => ({
  getPackageRuntimeContract: mocks.getPackageRuntimeContract
}))
vi.mock('./store', () => ({
  configureFreshLeanSpeechDefaults: vi.fn(),
  getAdminLocalSpeechPackPolicy: vi.fn(),
  getSettings: vi.fn(),
  getSpeechPackPolicyIdentity: vi.fn(),
  getSpeechPackSelectionIdentity: vi.fn(),
  readSettingsAtAuthorityBoundary: mocks.readSettingsAtAuthorityBoundary
}))
vi.mock('./model-policy-client', () => ({
  getSpeechPolicyAuthorityStatus: mocks.getSpeechPolicyAuthorityStatus
}))
vi.mock('@shared/package-profile', () => ({ METIS_PACKAGE_PROFILE: 'full' }))
vi.mock('electron', () => ({
  app: { getVersion: () => '2.1.0', getPath: mocks.asrModelPath },
  net: { fetch: mocks.asrFetch }
}))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn() } }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const options = () => ({
  resourcesRoot: '/resources',
  packaged: true,
  rootDir: '/packs',
  fixtureWavPath: '/fixture.wav',
  selectedEngine: () => 'whisper' as const,
  policyAllowsTransfer: () => true,
  captureActive: () => false,
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  assertMainWindow: vi.fn(),
  sendProgress: vi.fn()
})

describe('speech-pack desktop lifecycle', () => {
  it.each([
    'sender',
    'authentication',
    'invalid runtime',
    'lean runtime',
    'unreadable settings',
    'blocked local policy',
    'unverified policy',
    'configured without verified policy'
  ] as const)('the real composed ASR handler refuses %s without transfer', async (refusal) => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler)
    } as unknown as Electron.IpcMain
    const settings = {
      ...DEFAULT_SETTINGS,
      enterpriseLive: { ...DEFAULT_SETTINGS.enterpriseLive, managed: false, inferenceMode: 'legacy' as const },
      operatorUrl: refusal === 'configured without verified policy' ? 'https://operator.example.test' : '',
      operatorIngestSecret: '',
      operatorLicenseToken: ''
    }
    mocks.getPackageRuntimeContract.mockResolvedValue({
      status: refusal === 'invalid runtime' ? 'invalid' : 'legacy-full',
      profile: refusal === 'lean runtime' ? 'lean' : 'full',
      inventory: null
    })
    mocks.readSettingsAtAuthorityBoundary.mockResolvedValue({
      settings,
      readable: refusal !== 'unreadable settings',
      allowedProviders: null,
      localSpeechPack: refusal === 'blocked local policy' ? 'blocked' : null
    })
    mocks.getSpeechPolicyAuthorityStatus.mockReturnValue({
      status: refusal === 'unverified policy' ? 'unverified' : 'unconfigured',
      identity: 'fixture-policy'
    })
    const assertMainWindow = vi.fn(() => {
      if (refusal === 'sender') throw new Error('Rejected ASR sender')
    })
    const requireAuth = vi.fn(() => refusal !== 'authentication')
    const auditAsrTransfer = vi.fn()
    const ensureLocalModel = vi.fn(async () => false)
    registerOptionalModelProvisioningIpc({
      ipcMain,
      assertMainWindow,
      requireAuth,
      ensureLocalModel,
      captureActive: () => false,
      captureIdentity: () => 'capture:0',
      localModelIdentity: () => 'model:0',
      currentModelPolicyIdentity: () => 'policy:0',
      refreshScreenPreprocess: vi.fn(),
      logProvisioningFailure: vi.fn(),
      auditAsrTransfer
    })
    expect(handlers.has(IPC.localModelsEnsure)).toBe(true)
    expect(mocks.getPackageRuntimeContract).not.toHaveBeenCalled()
    expect(mocks.readSettingsAtAuthorityBoundary).not.toHaveBeenCalled()
    expect(mocks.getSpeechPolicyAuthorityStatus).not.toHaveBeenCalled()
    expect(requireAuth).not.toHaveBeenCalled()
    const handler = handlers.get(IPC.asrModelFetch)
    if (!handler) throw new Error('Actual composed ASR fetch handler was not registered')
    const event = {} as Electron.IpcMainInvokeEvent
    if (refusal === 'sender') await expect(handler(event)).rejects.toThrow('Rejected ASR sender')
    else await expect(handler(event)).resolves.toEqual({ ok: false })
    expect(assertMainWindow).toHaveBeenCalledExactlyOnceWith(event)
    expect(requireAuth).toHaveBeenCalledTimes(refusal === 'sender' ? 0 : 1)
    expect(mocks.getPackageRuntimeContract).toHaveBeenCalledTimes(
      ['sender', 'authentication'].includes(refusal) ? 0 : 1
    )
    const reachesPolicy = !['sender', 'authentication', 'invalid runtime', 'lean runtime'].includes(refusal)
    expect(mocks.readSettingsAtAuthorityBoundary).toHaveBeenCalledTimes(reachesPolicy ? 1 : 0)
    expect(mocks.getSpeechPolicyAuthorityStatus).toHaveBeenCalledTimes(
      reachesPolicy && refusal !== 'unreadable settings' ? 1 : 0
    )
    expect(auditAsrTransfer).not.toHaveBeenCalled()
    expect(ensureLocalModel).not.toHaveBeenCalled()
    expect(mocks.asrModelPath).not.toHaveBeenCalled()
    expect(mocks.asrFetch).not.toHaveBeenCalled()
  })

  it('admits an explicit ASR request through the real composed handler and audits before verified download I/O', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-asr-provisioning-'))
    const order: string[] = []
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler)
    } as unknown as Electron.IpcMain
    const settings = {
      ...DEFAULT_SETTINGS,
      enterpriseLive: { ...DEFAULT_SETTINGS.enterpriseLive, managed: false, inferenceMode: 'legacy' as const },
      operatorUrl: '',
      operatorIngestSecret: '',
      operatorLicenseToken: ''
    }
    mocks.getPackageRuntimeContract.mockImplementation(async () => {
      order.push('runtime')
      return { status: 'legacy-full', profile: 'full', inventory: null }
    })
    mocks.readSettingsAtAuthorityBoundary.mockImplementation(async () => {
      order.push('authority')
      return { settings, readable: true, allowedProviders: null, localSpeechPack: null }
    })
    mocks.getSpeechPolicyAuthorityStatus.mockImplementation(() => {
      order.push('policy')
      return { status: 'unconfigured', identity: 'fixture-policy' }
    })
    const auditAsrTransfer = vi.fn(() => {
      order.push('audit')
    })
    mocks.asrModelPath.mockImplementation((name) => {
      expect(name).toBe('userData')
      expect(auditAsrTransfer).toHaveBeenCalledOnce()
      order.push('path')
      return root
    })
    mocks.asrFetch.mockImplementation(async (url) => {
      expect(url).toBe(
        'https://huggingface.co/fixture/asr-provisioning/resolve/0123456789012345678901234567890123456789/model.bin'
      )
      expect(auditAsrTransfer).toHaveBeenCalledOnce()
      order.push('network')
      return new Response('abc', { headers: { 'content-length': '3' } })
    })
    const ensureLocalModel = vi.fn(async () => false)
    const assertMainWindow = vi.fn(() => {
      order.push('sender')
    })
    const requireAuth = vi.fn(() => {
      order.push('authentication')
      return true
    })
    try {
      registerOptionalModelProvisioningIpc({
        ipcMain,
        assertMainWindow,
        requireAuth,
        ensureLocalModel,
        captureActive: () => false,
        captureIdentity: () => 'capture:0',
        localModelIdentity: () => 'model:0',
        currentModelPolicyIdentity: () => 'policy:0',
        refreshScreenPreprocess: vi.fn(),
        logProvisioningFailure: vi.fn(),
        auditAsrTransfer
      })
      expect(order).toEqual([])
      expect(mocks.asrModelPath).not.toHaveBeenCalled()
      expect(mocks.asrFetch).not.toHaveBeenCalled()
      const handler = handlers.get(IPC.asrModelFetch)
      if (!handler) throw new Error('Actual composed ASR fetch handler was not registered')
      const event = {} as Electron.IpcMainInvokeEvent
      await expect(handler(event)).resolves.toEqual({ ok: true })
      expect(order.slice(0, 6)).toEqual(['sender', 'authentication', 'runtime', 'authority', 'policy', 'audit'])
      expect(order.indexOf('path')).toBeGreaterThan(order.indexOf('audit'))
      expect(order.indexOf('network')).toBeGreaterThan(order.indexOf('path'))
      expect(assertMainWindow).toHaveBeenCalledExactlyOnceWith(event)
      expect(requireAuth).toHaveBeenCalledOnce()
      expect(auditAsrTransfer).toHaveBeenCalledOnce()
      expect(mocks.asrFetch).toHaveBeenCalledOnce()
      expect(ensureLocalModel).not.toHaveBeenCalled()
      expect(await isHighTierAsrModelReady(mocks.asrFixture, join(root, 'asr-models'))).toBe(true)
      expect(asrModelDownloadState()).toEqual({ status: 'ready', progress: 1 })
    } finally {
      mocks.getPackageRuntimeContract.mockReset()
      mocks.readSettingsAtAuthorityBoundary.mockReset()
      mocks.getSpeechPolicyAuthorityStatus.mockReset()
      mocks.asrModelPath.mockImplementation(() => {
        throw new Error('Refused ASR request reached model-path I/O')
      })
      mocks.asrFetch.mockImplementation(() => {
        throw new Error('Refused ASR request reached network I/O')
      })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['admitted', true],
    ['unreadable policy', false]
  ] as const)('wires explicit local-model readiness through the IPC helper for %s admission', async (_, readable) => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler)
    } as unknown as Electron.IpcMain
    const modelPolicyIdentity = 'policy:unmanaged:0'
    const settings = {
      ...DEFAULT_SETTINGS,
      localLlm: { ...DEFAULT_SETTINGS.localLlm, modelId: 'qwen3.5-0.8b' },
      enterpriseLive: { ...DEFAULT_SETTINGS.enterpriseLive, managed: false, inferenceMode: 'legacy' as const },
      operatorUrl: '',
      operatorIngestSecret: '',
      operatorLicenseToken: ''
    }
    mocks.getPackageRuntimeContract.mockResolvedValue({ status: 'legacy-full', profile: 'full', inventory: null })
    mocks.readSettingsAtAuthorityBoundary.mockResolvedValue({
      settings,
      readable,
      allowedProviders: null,
      localSpeechPack: null
    })
    mocks.getSpeechPolicyAuthorityStatus.mockReturnValue({
      status: 'unconfigured',
      identity: modelPolicyIdentity
    })
    const ensureLocalModel = vi.fn(
      async (_modelId: string, authorized: () => Promise<boolean>, validateCurrent: () => boolean) =>
        (await authorized()) && validateCurrent()
    )
    const refreshScreenPreprocess = vi.fn()

    registerOptionalModelProvisioningIpc({
      ipcMain,
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      ensureLocalModel,
      captureActive: () => false,
      captureIdentity: () => 'capture:0',
      localModelIdentity: () => 'local-model:0',
      currentModelPolicyIdentity: () => modelPolicyIdentity,
      refreshScreenPreprocess,
      logProvisioningFailure: vi.fn(),
      auditAsrTransfer: vi.fn()
    })

    const handler = handlers.get(IPC.localModelsEnsure)
    if (!handler) throw new Error('explicit model ensure handler was not registered')
    await expect(handler({} as Electron.IpcMainInvokeEvent)).resolves.toEqual({ ok: readable })
    expect(ensureLocalModel).toHaveBeenCalledTimes(readable ? 1 : 0)
    expect(refreshScreenPreprocess).toHaveBeenCalledTimes(readable ? 1 : 0)
  })

  it('refreshes current policy, selection and capture without starting a transfer', async () => {
    vi.useFakeTimers()
    const active = vi.fn().mockReturnValue(false)
    const desktop = startSpeechPackDesktop({ ...options(), captureActive: active })
    expect(mocks.service.captureActivityChanged).toHaveBeenLastCalledWith(false)
    active.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.service.policyChanged).toHaveBeenCalledTimes(2)
    expect(mocks.service.selectionChanged).toHaveBeenCalledTimes(2)
    expect(mocks.service.captureActivityChanged).toHaveBeenLastCalledWith(true)
    await desktop.shutdown()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.service.policyChanged).toHaveBeenCalledTimes(2)
    expect(mocks.unregister).toHaveBeenCalledOnce()
  })

  it('keeps transfers disallowed when the policy reader throws', async () => {
    const desktop = startSpeechPackDesktop({
      ...options(),
      policyAllowsTransfer: () => {
        throw new Error('private failure')
      }
    })
    const passed = mocks.createSpeechPackService.mock.calls.at(-1)?.[0] as unknown as {
      policyAllowsTransfer: () => boolean
    }
    expect(passed.policyAllowsTransfer()).toBe(false)
    await desktop.shutdown()
  })

  it('shares one shutdown promise and waits for the owned service', async () => {
    let finish: () => void = () => {}
    mocks.service.shutdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const desktop = startSpeechPackDesktop(options())
    const first = desktop.shutdown()
    const second = desktop.shutdown()
    expect(first).toBe(second)
    expect(mocks.unregister).toHaveBeenCalledOnce()
    let completed = false
    void first.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    finish()
    await first
    expect(mocks.service.shutdown).toHaveBeenCalledOnce()
  })

  it('holds repeated quit requests until service shutdown settles', async () => {
    let finish: () => void = () => {}
    mocks.service.shutdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const desktop = startSpeechPackDesktop(options())
    const event = { preventDefault: vi.fn() }
    const quit = vi.fn()
    desktop.beforeQuit(event, quit)
    desktop.beforeQuit(event, quit)
    expect(quit).not.toHaveBeenCalled()
    finish()
    await desktop.shutdown()
    await Promise.resolve()
    expect(quit).toHaveBeenCalledOnce()
    event.preventDefault.mockClear()
    desktop.beforeQuit(event, quit)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('resumes the original quit when no diagnostic observer is installed', async () => {
    const desktop = startSpeechPackDesktop(options())
    const event = { preventDefault: vi.fn() }
    const quit = vi.fn()

    desktop.beforeQuit(event, quit)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

    expect(mocks.service.shutdown).toHaveBeenCalledOnce()
  })

  it('resumes the original quit when diagnostic tracing is disabled', async () => {
    const lines: string[] = []
    const desktop = startSpeechPackDesktop({
      ...options(),
      quitTrace: createQuitTrace(false, (line) => lines.push(line))
    })
    const event = { preventDefault: vi.fn() }
    const quit = vi.fn()

    desktop.beforeQuit(event, quit)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

    expect(mocks.service.shutdown).toHaveBeenCalledOnce()
    expect(lines).toEqual([])
  })

  it.each([
    'absent',
    'disabled'
  ] as const)('preserves the service shutdown promise identity when tracing is %s', (traceMode) => {
    const serviceShutdown = Promise.resolve()
    mocks.service.shutdown.mockImplementationOnce(() => serviceShutdown)
    const quitTrace = traceMode === 'disabled' ? createQuitTrace(false, () => undefined) : undefined
    const desktop = startSpeechPackDesktop({ ...options(), quitTrace })

    expect(desktop.shutdown()).toBe(serviceShutdown)
  })

  it('preserves the existing meeting flush window even when model shutdown finishes immediately', async () => {
    vi.useFakeTimers()
    const desktop = startSpeechPackDesktop(options())
    const quit = vi.fn()
    desktop.beforeQuit({ preventDefault: vi.fn() }, quit, true)
    await vi.advanceTimersByTimeAsync(1999)
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(quit).toHaveBeenCalledOnce()
  })

  it('still stops owned work when IPC deregistration throws', async () => {
    mocks.unregister.mockImplementationOnce(() => {
      throw new Error('/private/cleanup')
    })
    const desktop = startSpeechPackDesktop(options())
    await expect(desktop.shutdown()).rejects.toThrow(/^Speech pack cleanup failed$/)
    expect(mocks.service.shutdown).toHaveBeenCalledOnce()
  })
})
