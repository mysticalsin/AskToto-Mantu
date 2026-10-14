import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, IPC } from '@shared/ipc'
import { createQuitTrace } from './lifecycle/quit-trace'
import { registerOptionalModelProvisioningIpc, startSpeechPackDesktop } from './speech-pack-bootstrap'

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
    getSpeechPolicyAuthorityStatus: vi.fn()
  }
})
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
vi.mock('electron', () => ({ app: { getVersion: () => '2.1.0' } }))

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
