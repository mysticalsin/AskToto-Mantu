/**
 * eventkit-helper-host.ts: the only place Apple Calendar (EventKit) work is started (G65, FF-10).
 *
 * One short-lived `metis-mac-helper calendar-*` child per call, argv array, no shell. Event text goes to the child on
 * stdin as JSON and never in argv. Helper output is parsed and dropped: stdout and stderr are never logged, because they
 * can carry event titles and identifiers. A call that never started the child is `unavailable` (nothing happened); a
 * child that started a create and then timed out, crashed or printed something unreadable is `uncertain`, because the
 * save may already have happened.
 */
import { spawn } from 'node:child_process'
import { z } from 'zod'

export type EventKitPermission = 'notDetermined' | 'denied' | 'restricted' | 'writeOnly' | 'fullAccess'

export interface EventKitEventInput {
  subject: string
  body: string
  startIso: string
  endIso: string
}

export type EventKitCreateOutcome =
  | { kind: 'created'; id: string }
  | { kind: 'permission' }
  /** The helper reported that nothing was saved. */
  | { kind: 'failed' }
  /** The save may or may not have happened. Never retried. */
  | { kind: 'uncertain' }
  /** The helper cannot run here (not macOS, no binary, spawn failed). Nothing happened. */
  | { kind: 'unavailable' }

export type EventKitReadOutcome =
  | { kind: 'found'; subject: string; startIso: string; endIso: string; cancelled: boolean }
  | { kind: 'missing' }
  | { kind: 'unknown' }

export interface EventKitRunResult {
  /** False when the child could not be created at all. */
  spawned: boolean
  timedOut: boolean
  exitCode: number | null
  stdout: string
}
export type EventKitRun = (
  command: string,
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number
) => Promise<EventKitRunResult>

export interface EventKitHost {
  /** Never prompts. Null when the helper is unavailable or answered something unknown. */
  status(): Promise<EventKitPermission | null>
  /** The only call that may raise the Calendar prompt. Main calls it after the owner pressed Confirm. */
  ask(): Promise<EventKitPermission | null>
  create(input: EventKitEventInput): Promise<EventKitCreateOutcome>
  read(id: string): Promise<EventKitReadOutcome>
}

export interface EventKitHostDeps {
  platform: NodeJS.Platform
  /** Absolute helper path, or null when the helper is not present. */
  helperPath(): string | null
  run?: EventKitRun
}

const STATUS_MS = 5_000
const ASK_MS = 120_000
const CREATE_MS = 15_000
const READ_MS = 15_000
const MAX_STDOUT_CHARS = 16_384

const PermissionSchema = z.enum(['notDetermined', 'denied', 'restricted', 'writeOnly', 'fullAccess'])
const StatusReply = z.object({ status: PermissionSchema })
const CreateReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), id: z.string().min(1).max(512) }),
  z.object({ ok: z.literal(false), error: z.string().max(64) })
])
const ReadReply = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    subject: z.string().max(1_000),
    startIso: z.string().max(40),
    endIso: z.string().max(40),
    cancelled: z.boolean()
  }),
  z.object({ ok: z.literal(false), error: z.string().max(64) })
])

export const spawnEventKitHelper: EventKitRun = (command, args, stdin, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let timedOut = false
    const finish = (result: EventKitRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve({ spawned: false, timedOut: false, exitCode: null, stdout: '' })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk.toString('utf8')
    })
    child.once('error', () => finish({ spawned: false, timedOut: false, exitCode: null, stdout: '' }))
    child.once('close', (code) =>
      finish({ spawned: true, timedOut, exitCode: code, stdout: stdout.slice(0, MAX_STDOUT_CHARS) })
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdin ?? '')
  })

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim())
  } catch {
    return undefined
  }
}

export function createEventKitHost(deps: EventKitHostDeps): EventKitHost {
  const run = deps.run ?? spawnEventKitHelper
  const helper = (): string | null => (deps.platform === 'darwin' ? deps.helperPath() : null)

  const permissionCall = async (command: string, timeoutMs: number): Promise<EventKitPermission | null> => {
    const path = helper()
    if (!path) return null
    const r = await run(path, [command], undefined, timeoutMs)
    if (!r.spawned || r.timedOut || r.exitCode !== 0) return null
    const parsed = StatusReply.safeParse(parseJson(r.stdout))
    return parsed.success ? parsed.data.status : null
  }

  return {
    status: () => permissionCall('calendar-status', STATUS_MS),
    ask: () => permissionCall('calendar-access-ask', ASK_MS),

    async create(input) {
      const path = helper()
      if (!path) return { kind: 'unavailable' }
      const r = await run(path, ['calendar-event-create'], JSON.stringify(input), CREATE_MS)
      if (!r.spawned) return { kind: 'unavailable' }
      if (r.timedOut || r.exitCode !== 0) return { kind: 'uncertain' }
      const parsed = CreateReply.safeParse(parseJson(r.stdout))
      if (!parsed.success) return { kind: 'uncertain' }
      if (parsed.data.ok) return { kind: 'created', id: parsed.data.id }
      return parsed.data.error === 'permission' ? { kind: 'permission' } : { kind: 'failed' }
    },

    async read(id) {
      const path = helper()
      if (!path) return { kind: 'unknown' }
      const r = await run(path, ['calendar-event-read', id], undefined, READ_MS)
      if (!r.spawned || r.timedOut || r.exitCode !== 0) return { kind: 'unknown' }
      const parsed = ReadReply.safeParse(parseJson(r.stdout))
      if (!parsed.success) return { kind: 'unknown' }
      if (!parsed.data.ok) return parsed.data.error === 'not_found' ? { kind: 'missing' } : { kind: 'unknown' }
      const { subject, startIso, endIso, cancelled } = parsed.data
      return { kind: 'found', subject, startIso, endIso, cancelled }
    }
  }
}
