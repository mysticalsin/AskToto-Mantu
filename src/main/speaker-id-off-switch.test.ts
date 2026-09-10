import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(join(__dirname, 'index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const liveSpeakerReceipts = new Map()
const importSpeakerOwners = new Map()
const warnSpeakerFailure = vi.fn()
const speakerIdPolicyGlobals = { liveSpeakerReceipts, importSpeakerOwners }

function actualFunction(name: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  expect(declaration, `Actual source function ${name} was not found`).toBeDefined()
  if (!declaration) return () => undefined
  const compiled = ts.transpileModule(`${declaration.getText(source)}\nglobalThis.result = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext(globals)
  vm.runInContext(compiled, context, { timeout: 1_000 })
  return context.result
}

function ipcHandlerCalls(channel: string, callee: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'ipcMain' &&
      node.expression.name.text === 'handle' &&
      node.arguments[0]?.getText(source) === `IPC.${channel}`
    ) {
      const callback = node.arguments[1]
      const inspectCallback = (child: ts.Node): void => {
        if (ts.isCallExpression(child) && child.expression.getText(source) === callee) found = true
        ts.forEachChild(child, inspectCallback)
      }
      if (callback) inspectCallback(callback)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function importDeps(settings: { speakerId: { enabled: boolean } }, speakerId: Record<string, any>) {
  let captured: Record<string, any> | undefined
  const noop = () => undefined
  const beginImportSpeakers = vi.fn(() => true)
  const captureImportSpeakerKey = vi.fn(() => 'import:test')
  const disposeImportSpeakers = vi.fn()
  const applySpeakerIdPolicy = actualFunction('applySpeakerIdPolicy', {
    speakerIdInstance: speakerId,
    ...speakerIdPolicyGlobals
  })
  const speakerIdProcessingEnabled = actualFunction('speakerIdProcessingEnabled', {
    getSettings: () => settings,
    applySpeakerIdPolicy,
    liveSpeakerReceipts,
    importSpeakerOwners
  })
  const finalizeImportSpeakers = vi.fn(() => (settings.speakerId.enabled ? new Map([['Speaker 1', 'Speaker 1']]) : null))
  actualFunction('initializeImportJobs', {
    importJobs: null,
    wireIntelligenceIndexWork: noop,
    ImportJobManager: class { constructor(deps: Record<string, any>) { captured = deps } },
    EncryptedImportJobStore: class {},
    getSettings: () => ({ ...settings, asrLanguage: 'auto', asrEngine: 'parakeet', mode: 'meeting' }),
    getSpeakerId: () => speakerId,
    speakerIdProcessingEnabled,
    beginImportSpeakers,
    captureImportSpeakerKey,
    finalizeImportSpeakers,
    disposeImportSpeakers,
    labelThemAudio: actualFunction('labelThemAudio', {
      speakerIdProcessingEnabled,
      getSpeakerId: () => speakerId,
      liveSpeakerReceipts,
      importSpeakerOwners,
      warnSpeakerFailure,
      mainLog: { warn: vi.fn() }
    }),
    resetImportLanguageFollow: noop,
    startImportDecoder: noop,
    parakeetTranscribe: noop,
    whisperImportTranscribe: noop,
    detectImportLanguage: noop,
    ensureParakeetModel: noop,
    resetImportDecoder: noop,
    deleteMeeting: noop,
    enqueueIngest: noop,
    recordMeetingSummarized: noop,
    publishImportJob: noop,
    closeImportDecoder: noop,
    stopWhisperHost: noop,
    listeningActive: false,
    parakeetRelease: noop,
    releaseSpeakerEmbedding: noop,
    runIntelligenceIndex: noop,
    MAX_CONCURRENT_DECODES: 1,
    ensureImportAsrAssets: () => Promise.resolve(),
    runImportedRecap: noop,
    mainLog: { warn: noop, error: noop },
    liveSpeakerReceipts,
    importSpeakerOwners,
    warnSpeakerFailure
  })()
  if (!captured) throw new Error('ImportJobManager dependencies were not captured')
  return captured
}

describe('Speaker Intelligence hard off-switch wiring', () => {
  beforeEach(() => {
    liveSpeakerReceipts.clear()
    importSpeakerOwners.clear()
    warnSpeakerFailure.mockReset()
  })

  it('disabled import decode, labeling, and finalization perform no speaker work', async () => {
    const settings = { speakerId: { enabled: false } }
    const speakerId = {
      discardSession: vi.fn(),
      resetSession: vi.fn(),
      labelSessionWindow: vi.fn(async () => ({ name: 'Speaker 1' })),
      finalizeSessionByKey: vi.fn(() => new Map([['Speaker 1', 'Speaker 1']]))
    }
    const deps = importDeps(settings, speakerId)

    await deps.decode({ jobId: 'disabled-import' })
    const attempt = { jobId: 'disabled-import', attemptId: 1 }
    const label = await deps.speakerFor(Float32Array.from([0.1]), attempt)
    const finalized = deps.finalizeSpeakers(attempt)

    expect(speakerId.resetSession).not.toHaveBeenCalled()
    expect(speakerId.labelSessionWindow).not.toHaveBeenCalled()
    expect(speakerId.finalizeSessionByKey).not.toHaveBeenCalled()
    expect(label).toBeNull()
    expect(finalized).toBeNull()
  })

  it('a settings disable transition invalidates pending speaker continuations without creating an instance', () => {
    const discardSession = vi.fn()
    const applyExisting = actualFunction('applySpeakerIdPolicy', {
      speakerIdInstance: { discardSession },
      ...speakerIdPolicyGlobals
    })
    const applyAbsent = actualFunction('applySpeakerIdPolicy', {
      speakerIdInstance: null,
      ...speakerIdPolicyGlobals
    })

    expect(applyExisting(false)).toBe(false)
    expect(discardSession).toHaveBeenCalledTimes(1)
    expect(applyAbsent(false)).toBe(false)
  })

  it('a live label that completes after the setting turns off is not returned', async () => {
    const settings = { speakerId: { enabled: true } }
    let resolve!: (value: { name: string }) => void
    const speakerId = {
      discardSession: vi.fn(),
      labelSessionWindow: vi.fn(() => new Promise((done) => { resolve = done }))
    }
    const applySpeakerIdPolicy = actualFunction('applySpeakerIdPolicy', {
      speakerIdInstance: speakerId,
      ...speakerIdPolicyGlobals
    })
    const speakerIdProcessingEnabled = actualFunction('speakerIdProcessingEnabled', {
      getSettings: () => settings,
      applySpeakerIdPolicy
    })
    const label = actualFunction('labelThemAudio', {
      speakerIdProcessingEnabled,
      getSpeakerId: () => speakerId,
      warnSpeakerFailure,
      liveSpeakerReceipts,
      importSpeakerOwners,
      mainLog: { warn: vi.fn() }
    })

    const pending = label(Float32Array.from([0.1]), 'live:1', 'live')
    settings.speakerId.enabled = false
    applySpeakerIdPolicy(false)
    resolve({ name: 'Speaker 1' })

    await expect(pending).resolves.toBeNull()
    expect(speakerId.discardSession).toHaveBeenCalled()
  })

  it('disabled live operator observation performs no speaker extraction', async () => {
    const settings = { speakerId: { enabled: false } }
    const speakerId = { discardSession: vi.fn(), observeSessionOperatorWindow: vi.fn() }
    const applySpeakerIdPolicy = actualFunction('applySpeakerIdPolicy', {
      speakerIdInstance: speakerId,
      ...speakerIdPolicyGlobals
    })
    const speakerIdProcessingEnabled = actualFunction('speakerIdProcessingEnabled', {
      getSettings: () => settings,
      applySpeakerIdPolicy
    })
    const observe = actualFunction('observeOperatorAudio', {
      speakerIdProcessingEnabled,
      getSpeakerId: () => speakerId,
      liveSpeakerReceipts,
      importSpeakerOwners,
      warnSpeakerFailure,
      mainLog: { warn: vi.fn() }
    })

    await observe(Float32Array.from([0.1]))

    expect(speakerId.observeSessionOperatorWindow).not.toHaveBeenCalled()
  })

  it('disabled backfill preserves transcript naming but performs no enrollment', async () => {
    const lines = [{ t: 1_000, text: 'Synthetic transcript text', name: 'Speaker 1', speaker: 'them' }]
    const settings = { speakerId: { enabled: false } }
    const updateMeetingTranscript = vi.fn(async () => ({ ok: true }))
    const speakerId = { discardSession: vi.fn(), autoEnrollFromLabeledWindows: vi.fn(() => 1) }
    const applySpeakerIdPolicy = actualFunction('applySpeakerIdPolicy', {
      speakerIdInstance: speakerId,
      ...speakerIdPolicyGlobals
    })
    const speakerIdProcessingEnabled = actualFunction('speakerIdProcessingEnabled', {
      getSettings: () => settings,
      applySpeakerIdPolicy
    })
    const backfill = actualFunction('backfillSpeakerNames', {
      requireAuth: () => true,
      getSettings: () => settings,
      speakerIdProcessingEnabled,
      safeMeetingBasename: (file: string) => file,
      recallRead: async () => ({ ok: true, lines, startedAt: 1_000 }),
      fetchTeamsTranscriptForMeeting: async () => ({ entries: [] }),
      authStatus: () => ({ name: 'Synthetic operator' }),
      applySpeakerNames: () => ({ named: 1, lines: [{ ...lines[0], name: 'Resolved person' }] }),
      clusterNamePairsFromAlignment: () => [{ clusterLabel: 'Speaker 1', name: 'Resolved person' }],
      getSpeakerId: () => speakerId,
      auditLog: vi.fn(),
      updateMeetingTranscript,
      enqueueIngest: async () => undefined,
      resolveMeetingsFolder: () => '/unused',
      join,
      mainLog: { warn: vi.fn() }
    })

    await expect(backfill('synthetic.md')).resolves.toEqual({ ok: true, named: 1 })
    expect(speakerId.autoEnrollFromLabeledWindows).not.toHaveBeenCalled()
    expect(updateMeetingTranscript).toHaveBeenCalledWith(
      settings,
      'synthetic.md',
      [{ ...lines[0], name: 'Resolved person' }]
    )
  })

  it('settings persistence and managed settings reads both apply the saved speaker policy', () => {
    const applySpeakerIdPolicy = vi.fn((enabled: boolean) => enabled)
    const setSettings = vi.fn(() => ({ speakerId: { enabled: false }, onboardingDone: true }))
    const publicSettings = vi.fn(() => ({ speakerId: { enabled: false }, onboardingDone: true }))
    const save = actualFunction('setSettingsWithSpeakerPolicy', { setSettings, applySpeakerIdPolicy })
    const read = actualFunction('publicSettingsWithSpeakerPolicy', { publicSettings, applySpeakerIdPolicy })

    expect(save({ speakerId: { enabled: false } }).speakerId.enabled).toBe(false)
    expect(read().speakerId.enabled).toBe(false)
    expect(applySpeakerIdPolicy).toHaveBeenCalledTimes(2)
    expect(applySpeakerIdPolicy).toHaveBeenNthCalledWith(1, false)
    expect(applySpeakerIdPolicy).toHaveBeenNthCalledWith(2, false)
  })

  it('the settings handlers use the policy-aware persistence and managed-read boundaries', () => {
    expect(ipcHandlerCalls('settingsSet', 'setSettingsWithSpeakerPolicy')).toBe(true)
    expect(ipcHandlerCalls('settingsGet', 'publicSettingsWithSpeakerPolicy')).toBe(true)
  })
})
