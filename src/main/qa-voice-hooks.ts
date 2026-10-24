/**
 * qa-voice-hooks.ts — the QA-identity-only hooks that let the installed-app acceptance drive voice actions with no
 * real keyboard, no real microphone and no real desktop (V08, `--scenario voice-actions`).
 *
 * 1. METIS_QA_CHORD_FIFO: a FIFO inside the profile replaces the helper's stdout as the hold-chord watcher's line
 *    source. The harness writes the same `m <mask> <seq>` lines the platform helper prints, so the recognizer, the
 *    voice session, the lease, the capture and everything downstream are the real ones. Only the keyboard is fake.
 * 2. METIS_QA_DESKTOP_SINK=1: the durable task bridge dispatches into a recording sink instead of the OS adapters.
 *    It audits `qa.desktop_action.dispatched` (action id, outcome and the args hash, never an argument) and returns
 *    a scripted outcome, so the sandbox can never open the owner's Notes, browser or camera.
 *
 * Invariants:
 * - chord-wiring.ts and desktop-action-task-runtime.ts reach this module only under QA_IDENTITY_BUILD, so both env
 *   names and every string below are compiled out of shipping bytes; scripts/lib/qa-fault-hook.mjs proves it on every
 *   package through the two markers (QA_CHORD_FIFO_ENV, QA_DESKTOP_SINK_ENV), exactly as for qa-capture-source.ts.
 * - Inert unless the app is packaged, ASKTOTO_USERDATA names an isolated profile and the FIFO resolves (symlinks
 *   followed) to a FIFO inside that profile. If the env asks for the FIFO and any of that fails, the watcher gets NO
 *   source (fail closed): it never falls back to the real keyboard helper.
 * - Touches no permission surface. The audit events carry no path and no text.
 * - Module level has no side effects, so a shipping build tree-shakes the whole file.
 */
import { EventEmitter } from 'node:events'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import type { ActionEnvelope } from './action-guard'
import {
  spawnLineHelper,
  type LineHelperChild,
  type LineHelperHandle,
  type LineHelperHandlers,
  type LineHelperSpec
} from './infra/process/line-helper-host'

/** The env var naming the FIFO; also a packaged-bytes marker scripts/lib/qa-fault-hook.mjs looks for. */
export const QA_CHORD_FIFO_ENV = 'METIS_QA_CHORD_FIFO'
/** The env var turning the recording desktop sink on ('1' only); also a packaged-bytes marker. */
export const QA_DESKTOP_SINK_ENV = 'METIS_QA_DESKTOP_SINK'
/** The `command` of the spec the FIFO source hands the watcher. It is never executed: spawnHelper reads the FIFO. */
export const QA_CHORD_FIFO_COMMAND = 'qa-chord-fifo'

type Env = Readonly<Record<string, string | undefined>>

export type QaVoiceHookRefusal =
  | 'shipping-identity'
  | 'unpackaged'
  | 'no-profile'
  | 'not-requested'
  | 'relative-path'
  | 'outside-profile'

const isInside = (profile: string, path: string): boolean => {
  const inside = relative(profile, path)
  return !(!inside || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside))
}

interface BaseInput {
  readonly qaIdentity: boolean
  readonly packaged: boolean
  readonly env: Env
}

export type QaChordFifoDecision =
  | { readonly path: string; readonly profile: string; readonly reason: null }
  | { readonly path: null; readonly profile: null; readonly reason: QaVoiceHookRefusal }

/** Decide, from strings alone, whether the FIFO source may exist. The filesystem is checked again when it opens. */
export function qaChordFifoDecision({ qaIdentity, packaged, env }: BaseInput): QaChordFifoDecision {
  const refuse = (reason: QaVoiceHookRefusal): QaChordFifoDecision => ({ path: null, profile: null, reason })
  if (!qaIdentity) return refuse('shipping-identity')
  if (!packaged) return refuse('unpackaged')
  const requested = env[QA_CHORD_FIFO_ENV]?.trim()
  if (!requested) return refuse('not-requested')
  const profile = env.ASKTOTO_USERDATA?.trim()
  if (!profile) return refuse('no-profile')
  if (!isAbsolute(requested) || !isAbsolute(profile)) return refuse('relative-path')
  if (!isInside(profile, requested)) return refuse('outside-profile')
  return { path: requested, profile, reason: null }
}

/** The recording desktop sink is on only for a packaged QA-identity build on an isolated profile, with the value `1`. */
export function qaDesktopSinkEnabled({ qaIdentity, packaged, env }: BaseInput): boolean {
  return qaIdentity && packaged && Boolean(env.ASKTOTO_USERDATA?.trim()) && env[QA_DESKTOP_SINK_ENV]?.trim() === '1'
}

// ---------------------------------------------------------------------------------------------------------------
// The chord FIFO source

export interface QaFifoHandle {
  /** Bytes the harness wrote. Never ends: the handle holds the write side open too, so there is no EOF. */
  readonly stream: NodeJS.ReadableStream
  /** Unblocks a read the kernel is still waiting on, so closing never strands a thread-pool worker. */
  wake(): Promise<void>
  close(): Promise<void>
}

export interface QaFifoFs {
  realpath(path: string): Promise<string>
  isFifo(path: string): Promise<boolean>
  /** Open read and write: such an open never blocks for a peer. */
  open(path: string): Promise<QaFifoHandle>
}

export const nodeQaFifoFs: QaFifoFs = {
  realpath: (path) => realpath(path),
  isFifo: async (path) => (await stat(path)).isFIFO(),
  async open(path) {
    const handle = await open(path, 'r+')
    const stream = handle.createReadStream({ autoClose: false, emitClose: false })
    return {
      stream,
      wake: async () => {
        // Destroy first, so the stream cannot issue a fresh blocking read once the wake byte completes the one in
        // flight. Written the other way round, a loaded host could run that read's callback before destroy(); the new
        // read then blocks forever on the empty FIFO and handle.close() waits on it, so 'closed' is never audited.
        stream.destroy()
        await handle.write('\n').catch(() => undefined)
      },
      close: async () => {
        stream.destroy()
        await handle.close().catch(() => undefined)
      }
    }
  }
}

export type QaChordFifoAudit = (
  event: 'qa.chord_fifo',
  detail: { state: 'open' | 'closed' | 'refused'; reason?: string }
) => void

export interface QaChordFifoSource {
  /** The spec the watcher runs, or null when the request was refused (the watcher then stays inert, never real). */
  helperSpec(): LineHelperSpec | null
  spawnHelper(spec: LineHelperSpec, handlers: LineHelperHandlers): LineHelperHandle
}

export interface QaChordFifoInput extends BaseInput {
  readonly audit: QaChordFifoAudit
  readonly fs?: QaFifoFs
}

/**
 * The FIFO-backed watcher source, or null when the env does not ask for one (normal builds, normal runs). When it
 * asks and the request is invalid it still returns a source, with no spec: a refused request must not quietly
 * start the real keyboard helper.
 */
export function createQaChordFifoSource(input: QaChordFifoInput): QaChordFifoSource | null {
  const fs = input.fs ?? nodeQaFifoFs
  const decision = qaChordFifoDecision(input)
  if (decision.path === null) {
    // No request at all (a shipping build, an unpackaged run, no env): not ours. Anything else is a refusal to explain.
    const asked = input.qaIdentity && input.packaged && Boolean(input.env[QA_CHORD_FIFO_ENV]?.trim())
    if (!asked) return null
    input.audit('qa.chord_fifo', { state: 'refused', reason: decision.reason })
    return { helperSpec: () => null, spawnHelper: () => ({ kill: () => undefined }) }
  }
  const { path, profile } = decision

  const openChild = (): LineHelperChild => {
    const events = new EventEmitter()
    const stdout = new PassThrough()
    let handle: QaFifoHandle | null = null
    let killed = false
    const closeHandle = async (): Promise<void> => {
      const current = handle
      handle = null
      if (!current) return
      await current.wake()
      await current.close()
      input.audit('qa.chord_fifo', { state: 'closed' })
    }
    const refuse = (reason: string): void => {
      input.audit('qa.chord_fifo', { state: 'refused', reason })
      events.emit('error', new Error(`qa chord fifo refused: ${reason}`))
    }
    void (async () => {
      let realFifo: string
      let realProfile: string
      try {
        ;[realFifo, realProfile] = await Promise.all([fs.realpath(path), fs.realpath(profile)])
      } catch {
        return refuse('missing')
      }
      // Checked on the resolved paths so neither '..' nor a symlink can reach a FIFO outside the profile.
      if (!isInside(realProfile, realFifo)) return refuse('outside-profile')
      try {
        if (!(await fs.isFifo(realFifo))) return refuse('not-a-fifo')
      } catch {
        return refuse('missing')
      }
      let opened: QaFifoHandle
      try {
        opened = await fs.open(realFifo)
      } catch {
        return refuse('open-failed')
      }
      handle = opened
      if (killed) return void (await closeHandle())
      opened.stream.on('data', (chunk) => stdout.write(chunk))
      opened.stream.on('error', () => events.emit('error', new Error('qa chord fifo read failed')))
      input.audit('qa.chord_fifo', { state: 'open' })
    })()
    return {
      stdout,
      on(event: string, listener: (...args: any[]) => void) {
        events.on(event, listener)
        return this
      },
      kill() {
        if (killed) return true
        killed = true
        void closeHandle()
        return true
      }
    } as LineHelperChild
  }

  return {
    helperSpec: () => ({ command: QA_CHORD_FIFO_COMMAND, args: [] }),
    // The shared line splitter does the framing and the 256-character bound; only the byte source is ours.
    spawnHelper: (spec, handlers) => spawnLineHelper(spec, handlers, { spawn: () => openChild() })
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The recording desktop sink

/** What the sink reports per action. Only `create_note` is scripted `unknown`: it exercises the uncertain path. */
export function qaSinkOutcome(actionId: DesktopActionRequest['id']): 'verified' | 'unknown' {
  return actionId === 'desktop.create_note' ? 'unknown' : 'verified'
}

export type QaDesktopSinkAudit = (
  event: 'qa.desktop_action.dispatched',
  detail: { actionId: string; outcome: 'verified' | 'unknown'; argsHash: string }
) => void

/**
 * The recording executor: the same shape as the production one (request and envelope in, a result out), with no
 * process, no file and no URL behind it. `verified` carries a receipt bound to this dispatch, as a real readback would.
 */
export function createQaDesktopSink(audit: QaDesktopSinkAudit) {
  return async function qaDesktopSink(
    request: DesktopActionRequest,
    envelope?: ActionEnvelope
  ): Promise<DesktopActionResult> {
    const outcome = qaSinkOutcome(request.id)
    audit('qa.desktop_action.dispatched', {
      actionId: request.id,
      outcome,
      argsHash: envelope?.argsHash ?? ''
    })
    if (outcome === 'unknown' || !envelope) return { id: request.id, ok: true, outcome: 'unknown', detail: 'qa_sink' }
    return {
      id: request.id,
      ok: true,
      outcome: 'verified',
      detail: 'qa_sink',
      receipt: {
        idempotencyKey: envelope.idempotencyKey,
        argsHash: envelope.argsHash,
        observation: 'qa sink recorded the dispatch'
      }
    }
  }
}
