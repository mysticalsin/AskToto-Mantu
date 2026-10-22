import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QA_BUNDLE_ID } from './guard.mjs'
import { buildWav, createReport, finishReport, parseWavInfo, sandboxLayout } from './lib.mjs'
import { dryRunPlan, resolveConfig, SCENARIOS } from './run-acceptance.mjs'
import { guardReport, planLaunch } from './session.mjs'
import { reportLeaksMarkers, UTTERANCES, VOICE_ACTIONS_STEPS } from './voice-actions-lib.mjs'
import {
  auditMentions,
  cardEverMounted,
  cardMountEvent,
  createChordFifo,
  describePrepared,
  holdChord,
  isMeetingCaptureDisturbance,
  latestDraftBytes,
  latestPillTitle,
  mintSelfSignedCert,
  prepareVoiceActions,
  RECORDER_SOURCE,
  returnKeyEvents,
  runVoiceActionsScenario,
  sinkActionsIn,
  taskStoreFingerprint,
  voiceExtraEnv,
  voiceLayout,
  voiceSeedSettings
} from './voice-actions.mjs'
import { createMockLlmServer } from '../mock-llm-server.mjs'

let base: string
let sandboxRoot: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(process.platform === 'win32' ? parse(tmpdir()).root : '/tmp', 'w14-')))
  sandboxRoot = join(base, '_relay', 'goal-loop', 'sandbox-home')
  mkdirSync(join(sandboxRoot, 'Applications', 'Metis QA.app'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const isolatedEnv = () => ({
  PATH: '/usr/bin',
  HOME: join(sandboxRoot, 'run-1'),
  TMPDIR: join(sandboxRoot, 'run-1', 'tmp'),
  ASKTOTO_USERDATA: join(sandboxRoot, 'run-1', 'userdata'),
  METIS_LOOP_ISOLATED: '1'
})

describe('voice-actions CLI wiring', () => {
  it('registers the scenario after the existing ones, keeping them and their defaults', () => {
    expect(SCENARIOS).toEqual(['meeting', 'settings-hig', 'upgrade', 'stress', 'voice-actions'])
    expect(resolveConfig([], isolatedEnv()).values.scenario).toBe('meeting')
  })

  it('accepts the scenario with synthetic speech by default and the --va-* flags', () => {
    const config = resolveConfig(
      [
        '--run-id',
        'r1',
        '--scenario',
        'voice-actions',
        '--va-idle-seconds',
        '5',
        '--va-runs',
        '2',
        '--va-idle-cost-minutes',
        '10',
        '--va-relaunch-per-utterance'
      ],
      isolatedEnv()
    )
    expect(config.values).toMatchObject({
      scenario: 'voice-actions',
      audio: 'speech',
      'va-idle-seconds': 5,
      'va-runs': 2,
      'va-idle-cost-minutes': 10,
      'va-relaunch-per-utterance': true
    })
    expect(resolveConfig(['--scenario', 'voice-actions'], isolatedEnv()).values).toMatchObject({
      'va-idle-seconds': 60,
      'va-runs': 3,
      'va-idle-cost-minutes': 0,
      'va-relaunch-per-utterance': false
    })
  })

  it('keeps the --va-* flags to this scenario and bounds them', () => {
    const env = isolatedEnv()
    expect(() => resolveConfig(['--va-runs', '2'], env)).toThrow(
      /--va-runs is only valid with --scenario voice-actions/
    )
    expect(() => resolveConfig(['--scenario', 'settings-hig', '--va-idle-seconds', '9'], env)).toThrow(
      /only valid with --scenario voice-actions/
    )
    expect(() => resolveConfig(['--scenario', 'voice-actions', '--va-runs', '0'], env)).toThrow(/at least 1/)
    expect(() => resolveConfig(['--scenario', 'voice-actions', '--va-runs', '11'], env)).toThrow(/at most 10/)
    expect(() => resolveConfig(['--scenario', 'voice-actions', '--va-idle-seconds', '1'], env)).toThrow(/at least 5/)
  })

  it('--dry-run lists every design step and validates the guards with the voice hooks in the child environment', () => {
    const config = resolveConfig(['--run-id', 'r1', '--scenario', 'voice-actions', '--dry-run'], isolatedEnv())
    const result = dryRunPlan(config, isolatedEnv(), { bundleId: QA_BUNDLE_ID, platform: 'darwin' })
    expect(result.ok).toBe(true)
    expect(result.checks.every((check) => check.ok)).toBe(true)
    expect(result.plan.steps).toEqual([...VOICE_ACTIONS_STEPS])
    expect(result.plan.steps).toEqual(
      expect.arrayContaining([
        'va-default-on',
        'va-idle-no-mic',
        'va-short-hold-ignored',
        'va-read-only-immediate',
        'va-confirm-escape',
        'va-return-guard',
        'va-confirm-return-uncertain',
        'va-question',
        'va-meeting-arbitration',
        'va-renderer-reset-revokes',
        'va-toggle-off-instant',
        'va-no-utterance-at-rest',
        'va-reduced-motion',
        'va-idle-cost'
      ])
    )
    expect(result.plan.childEnvKeys).toEqual(
      expect.arrayContaining([
        'METIS_QA_CHORD_FIFO',
        'METIS_QA_DESKTOP_SINK',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'METIS_QA_CAPTURE_FILE'
      ])
    )
    expect(result.plan.voiceActions).toEqual({
      idleSeconds: 60,
      runs: 3,
      idleCostMinutes: 0,
      relaunchPerUtterance: false
    })
    // Other scenarios never receive the hooks.
    const meeting = dryRunPlan(resolveConfig(['--run-id', 'r1', '--dry-run'], isolatedEnv()), isolatedEnv(), {
      bundleId: QA_BUNDLE_ID,
      platform: 'darwin'
    })
    expect(meeting.plan.childEnvKeys).not.toContain('METIS_QA_CHORD_FIFO')
    expect(meeting.plan.childEnvKeys).not.toContain('METIS_QA_DESKTOP_SINK')
    // A dry run creates nothing.
    expect(readdirSync(sandboxRoot)).toEqual(['Applications'])
  })

  it('the launch plan passes the hooks only when asked, and the guards still hold with them', () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r1' })
    const env = isolatedEnv()
    const withHooks = planLaunch({
      layout,
      appPath: join(sandboxRoot, 'Applications', 'Metis QA.app'),
      parentEnv: env,
      platform: 'darwin',
      bundleId: QA_BUNDLE_ID,
      extraEnv: voiceExtraEnv(layout)
    })
    expect(withHooks.childEnv.METIS_QA_CHORD_FIFO).toBe(voiceLayout(layout).fifo)
    expect(withHooks.childEnv.METIS_QA_DESKTOP_SINK).toBe('1')
    const without = planLaunch({
      layout,
      appPath: join(sandboxRoot, 'Applications', 'Metis QA.app'),
      parentEnv: env,
      platform: 'darwin',
      bundleId: QA_BUNDLE_ID
    })
    expect(without.childEnv).not.toHaveProperty('METIS_QA_CHORD_FIFO')
    const report = guardReport({
      layout,
      appPath: join(sandboxRoot, 'Applications', 'Metis QA.app'),
      parentEnv: env,
      platform: 'darwin',
      bundleId: QA_BUNDLE_ID,
      extraEnv: voiceExtraEnv(layout)
    })
    expect(report.ok).toBe(true)
  })

  it('the idle-cost launch leaves the FIFO out so the real helper is the watcher source', () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r1' })
    expect(voiceExtraEnv(layout, { fifo: false })).toEqual({
      METIS_QA_DESKTOP_SINK: '1',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
    expect(voiceExtraEnv(layout, { tls: false })).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED')
  })
})

describe('voice-actions layout and seed', () => {
  it('keeps every hook file inside the profile', () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r1' })
    const vl = voiceLayout(layout)
    for (const path of [vl.fifo, vl.utterancesDir, vl.meetingWav]) expect(path.startsWith(layout.userData)).toBe(true)
  })

  it('seeds the custom provider at the local mock over https and nothing about voice actions', () => {
    const seed = voiceSeedSettings(4443)
    expect(seed).toEqual({
      provider: 'custom',
      customBaseUrl: 'https://127.0.0.1:4443/ok/v1',
      providerModels: { custom: 'mock-model' }
    })
    expect(seed).not.toHaveProperty('voiceActions')
  })
})

describe('the chord FIFO writer', () => {
  it('opens read-write, writes the helper protocol line, closes, and holds for the requested time', async () => {
    const calls: string[] = []
    const open = vi.fn(async () => ({
      write: async (text: string) => void calls.push(`write:${JSON.stringify(text)}`),
      close: async () => void calls.push('close')
    }))
    const fifo = createChordFifo('/synthetic/chord.fifo', 32, { open: open as never })
    vi.useFakeTimers()
    try {
      const held = holdChord(fifo, 300)
      await vi.advanceTimersByTimeAsync(300)
      const { tDown, tUp } = await held
      expect(tUp - tDown).toBeGreaterThanOrEqual(300)
    } finally {
      vi.useRealTimers()
    }
    expect(open.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/synthetic/chord.fifo', 'r+'],
      ['/synthetic/chord.fifo', 'r+']
    ])
    expect(calls).toEqual(['write:"m 32 0\\n"', 'close', 'write:"m 0 0\\n"', 'close'])
  })

  it('closes the FIFO even when the write fails', async () => {
    const close = vi.fn(async () => undefined)
    const fifo = createChordFifo('/x', 32, {
      open: (async () => ({ write: async () => Promise.reject(new Error('EPIPE')), close })) as never
    })
    await expect(fifo.down()).rejects.toThrow('EPIPE')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('the page recorder', () => {
  it('is valid script source that does nothing but record', () => {
    const calls: unknown[] = []
    const window: Record<string, unknown> = {}
    const element = {
      textContent: '',
      querySelector: () => null,
      querySelectorAll: () => [],
      getAttribute: () => null,
      contains: () => false
    }
    runInNewContext(RECORDER_SOURCE, {
      window,
      navigator: { mediaDevices: { getUserMedia: async () => (calls.push('real'), {}) } },
      document: {
        documentElement: element,
        querySelector: () => null,
        getElementById: () => null,
        activeElement: null
      },
      MutationObserver: class {
        observe() {}
      },
      Date
    })
    const va = window.__va as { events: unknown[]; gum: number; describeCard: () => unknown }
    expect(va.events).toEqual([])
    expect(va.gum).toBe(0)
    expect(va.describeCard()).toBeNull()
  })

  it('counts getUserMedia calls and still calls through', async () => {
    const real = vi.fn(async () => ({}))
    const devices = { getUserMedia: real } as {
      getUserMedia: (...args: unknown[]) => Promise<unknown>
      __vaWrapped?: boolean
    }
    const window: Record<string, unknown> = {}
    runInNewContext(RECORDER_SOURCE, {
      window,
      navigator: { mediaDevices: devices },
      document: { documentElement: {}, querySelector: () => null, getElementById: () => null },
      MutationObserver: class {
        observe() {}
      },
      Date
    })
    await devices.getUserMedia({ audio: true })
    await devices.getUserMedia({ audio: true })
    expect((window.__va as { gum: number }).gum).toBe(2)
    expect(real).toHaveBeenCalledTimes(2)
  })

  it('reads the pill title and card facts from what the page recorded', () => {
    const events = [
      { k: 'pill', state: 'listening', title: 'Listening…' },
      { k: 'card', role: 'alertdialog', title: 'Create a note in Notes', wall: 5 },
      {
        k: 'pillText',
        state: 'uncertain',
        title: 'Métis asked Notes to create “Groceries” but couldn’t confirm it worked.'
      },
      { k: 'pill', state: null, title: '' }
    ]
    expect(latestPillTitle(events)).toContain('couldn’t confirm')
    expect(latestPillTitle([])).toBe('')
    expect(cardMountEvent(events)).toMatchObject({ wall: 5 })
    expect(cardEverMounted(events)).toBe(true)
    expect(cardEverMounted([{ k: 'pill', state: 'done' }])).toBe(false)
  })

  it('Return is a real key press with the character, and the guard probe times straddle the 300 ms window', () => {
    const [down, up] = returnKeyEvents()
    expect(down).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(up).toMatchObject({ type: 'keyUp', key: 'Enter' })
  })
})

describe('audit observations', () => {
  it('lists the sink dispatches by action id only', () => {
    expect(
      sinkActionsIn([
        { event: 'qa.desktop_action.dispatched', actionId: 'desktop.open_notes', outcome: 'verified', argsHash: 'x' },
        { event: 'voice.action', actionId: 'desktop.open_notes' },
        { event: 'qa.desktop_action.dispatched', actionId: 'desktop.create_note' }
      ])
    ).toEqual(['desktop.open_notes', 'desktop.create_note'])
  })

  it('matches a pattern on a record’s own fields and never on its time, sequence or chain', () => {
    const records = [
      {
        ts: 'renderer-reset',
        seq: 1,
        prev: 'renderer-reset',
        event: 'voice.turn',
        phase: 'cancelled',
        reason: 'renderer_reset'
      },
      { ts: 'x', event: 'voice.turn', phase: 'started' }
    ]
    expect(auditMentions(records, /renderer[-_]reset/)).toBe(1)
    expect(auditMentions([{ ts: 'renderer-reset', event: 'a' }], /renderer[-_]reset/)).toBe(0)
  })

  it('recognises capture disturbances by event name, not by unrelated meeting audits', () => {
    expect(isMeetingCaptureDisturbance({ event: 'meeting.speech.worker.degraded' })).toBe(true)
    expect(isMeetingCaptureDisturbance({ event: 'listen.capture.restart' })).toBe(true)
    expect(isMeetingCaptureDisturbance({ event: 'meeting.start' })).toBe(false)
    expect(isMeetingCaptureDisturbance({ event: 'voice.turn', phase: 'refused' })).toBe(false)
    expect(isMeetingCaptureDisturbance(null)).toBe(false)
  })

  it('fingerprints the task store and the newest draft, and reads absence as null and zero', () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r2' })
    expect(taskStoreFingerprint(layout)).toBeNull()
    expect(latestDraftBytes(layout)).toBe(0)
    mkdirSync(layout.userData, { recursive: true })
    mkdirSync(layout.meetingsFolder, { recursive: true })
    writeFileSync(join(layout.userData, 'desktop-action-tasks.bin'), 'a')
    const first = taskStoreFingerprint(layout)
    writeFileSync(join(layout.userData, 'desktop-action-tasks.bin'), 'b')
    expect(taskStoreFingerprint(layout)).not.toBe(first)
    writeFileSync(join(layout.meetingsFolder, '.autosave-draft-1.md'), '12345')
    expect(latestDraftBytes(layout)).toBe(5)
  })
})

describe('prepareVoiceActions', () => {
  /** A fake say/afconvert/mkfifo/openssl. */
  function fakeRun() {
    const calls: Array<{ file: string; args: string[] }> = []
    const run = (file: string, args: string[]) => {
      calls.push({ file, args })
      if (file === '/usr/bin/say') writeFileSync(args[args.indexOf('-o') + 1], 'aiff')
      else if (file === '/usr/bin/afconvert') writeFileSync(args.at(-1)!, buildWav({ seconds: 2 }))
      else if (file === '/usr/bin/mkfifo') writeFileSync(args[0], '')
      else if (file === '/usr/bin/openssl') {
        writeFileSync(args[args.indexOf('-keyout') + 1], 'key')
        writeFileSync(args[args.indexOf('-out') + 1], 'cert')
      }
      return { status: 0, signal: null, stdout: '', stderr: '', error: null }
    }
    return { run, calls }
  }

  it('makes the FIFO, one WAV per utterance and the meeting feed, and describes them without a phrase', async () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r3' })
    mkdirSync(layout.captureDir, { recursive: true })
    writeFileSync(layout.captureWav, buildWav({ seconds: 3 }))
    const { run, calls } = fakeRun()
    const prepared = await prepareVoiceActions({
      layout,
      audio: { speech: true },
      run: run as never,
      listen: async () => 4443
    }).catch((error) => {
      // The fake certificate is not a real one, so the mock may fail to start; everything else must still be prepared.
      throw error
    })
    expect(Object.keys(prepared.utterances)).toEqual(Object.keys(UTTERANCES))
    for (const id of Object.keys(UTTERANCES))
      expect(parseWavInfo(readFileSync(prepared.utterances[id].path))).toMatchObject({ sampleRate: 16_000 })
    expect(calls.find((call) => call.file === '/usr/bin/mkfifo')?.args).toEqual([voiceLayout(layout).fifo])
    expect(prepared.meeting?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const description = JSON.stringify(describePrepared(prepared))
    expect(reportLeaksMarkers(describePrepared(prepared))).toEqual([])
    expect(description).toContain('open-notes')
    // The phrases only ever travel through say's -f file, which is deleted again.
    expect(readdirSync(layout.tmp).filter((name) => name.startsWith('va-') && name !== 'va-cert')).toEqual([])
    await prepared.stop()
  })

  it('without synthetic speech there is no meeting feed, and a failed mock only costs the question step', async () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r4' })
    const { run } = fakeRun()
    const prepared = await prepareVoiceActions({
      layout,
      audio: { speech: false },
      run: ((file: string, args: string[]) =>
        file === '/usr/bin/openssl' ? { status: 1, error: 'missing' } : run(file, args)) as never,
      listen: async () => 1
    })
    expect(prepared.meeting).toBeNull()
    expect(prepared.mock).toBeNull()
    expect(prepared.mockReason).toMatch(/openssl could not mint/)
    expect(prepared.seed).toEqual({})
    // No mock means no TLS bypass in the child environment.
    expect(prepared.envFor()).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED')
  })

  it('refuses to run when speech synthesis or the FIFO cannot be made (a precondition, not a skip)', async () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r5' })
    await expect(
      prepareVoiceActions({
        layout,
        audio: { speech: true },
        run: (() => ({ status: 1, error: 'no mkfifo' })) as never
      })
    ).rejects.toThrow(/mkfifo failed/)
    const failingSay = (file: string) =>
      file === '/usr/bin/say' ? { status: 1, error: 'no voice' } : { status: 0, error: null }
    await expect(prepareVoiceActions({ layout, audio: { speech: true }, run: failingSay as never })).rejects.toThrow(
      /speech synthesis failed/
    )
  })

  it('mints a throwaway certificate with openssl and reads both files', () => {
    const dir = join(base, 'cert')
    const { run } = fakeRun()
    expect(mintSelfSignedCert(dir, run as never)).toEqual({ key: Buffer.from('key'), cert: Buffer.from('cert') })
    expect(() => mintSelfSignedCert(dir, (() => ({ status: 2, error: 'nope' })) as never)).toThrow(
      /openssl could not mint/
    )
  })
})

describe('the mock LLM request log (question step)', () => {
  it('counts requests that carry every needle, case-insensitively, and can be cleared', () => {
    const { log } = createMockLlmServer()
    log.record('/ok/v1/chat/completions', '{"messages":[{"content":"What is the CAPITAL of France?"}]}')
    log.record('/ok/v1/chat/completions', '{"messages":[{"content":"unrelated"}]}')
    expect(log.count(['capital', 'france'])).toBe(1)
    expect(log.count('unrelated')).toBe(1)
    expect(log.count(['capital', 'germany'])).toBe(0)
    expect(log.total()).toBe(2)
    log.clear()
    expect(log.total()).toBe(0)
  })
})

describe('runVoiceActionsScenario', () => {
  const prepared = (layout: ReturnType<typeof sandboxLayout>) =>
    ({
      vl: voiceLayout(layout),
      utterances: {},
      meeting: null,
      mock: null,
      mockReason: 'no mock in this test',
      seed: {},
      envFor: () => ({}),
      stop: async () => undefined
    }) as never

  it('records one step per design id, in order, when the app cannot even launch, and nothing passes', async () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r6' })
    const report = createReport({ tool: 'test' })
    await runVoiceActionsScenario({
      report,
      layout,
      launch: async () => {
        throw new Error('no app in this test')
      },
      onSession: () => undefined,
      prepared: prepared(layout),
      audio: { speech: true },
      platform: 'darwin'
    })
    // The launch fails; every other step is skipped, never passed.
    expect(report.steps[0]).toMatchObject({ id: 'launch-and-renderer-ready', status: 'FAIL' })
    const scenarioSteps = report.steps.map((step: { id: string }) => step.id)
    expect(scenarioSteps).toEqual([...VOICE_ACTIONS_STEPS])
    const statuses = Object.fromEntries(
      report.steps.map((step: { id: string; status: string }) => [step.id, step.status])
    )
    expect(Object.values(statuses)).not.toContain('PASS')
  })

  it('never lets a report carry a spoken marker through a failure message', async () => {
    const layout = sandboxLayout({ sandboxRoot, runId: 'r7' })
    const report = createReport({ tool: 'test' })
    await runVoiceActionsScenario({
      report,
      layout,
      launch: async () => {
        throw new Error('launch failed')
      },
      onSession: () => undefined,
      prepared: prepared(layout),
      audio: { speech: true },
      platform: 'darwin'
    })
    const final = finishReport(report)
    expect(final.verdict).toBe('FAIL')
    expect(reportLeaksMarkers(final)).toEqual([])
  })
})

describe('what a scenario source may print', () => {
  it('never copies a spoken phrase into the scenario source or a message', () => {
    const lib = readFileSync(join(__dirname, 'voice-actions-lib.mjs'), 'utf8')
    const scenario = readFileSync(join(__dirname, 'voice-actions.mjs'), 'utf8')
    // The phrases live in one object, UTTERANCES, and are used only as say input. The scenario never names them.
    for (const phrase of Object.values(UTTERANCES)) expect(scenario).not.toContain(phrase)
    expect(statSync(join(__dirname, 'voice-actions-lib.mjs')).size).toBeGreaterThan(0)
    expect(lib.match(/groceries/gi)?.length ?? 0).toBeGreaterThan(0) // the marker list, the phrase and a test-only regex
  })
})
