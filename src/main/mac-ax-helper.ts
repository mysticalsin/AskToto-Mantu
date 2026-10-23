/**
 * mac-ax-helper.ts (G23): the typed gateway to the metis-mac-helper `ax-focus-snapshot` and `ax-insert` commands.
 *
 * The helper looks at the focused field of another application through macOS Accessibility. It reports hashes,
 * never the text of a field, and it never reads the value of a secure field. `ax-insert` takes its request on STDIN
 * (the dictated text must never appear in a process listing) and re-checks everything itself before it writes.
 * Everything here degrades to null: a missing, slow or malformed helper is "unsupported", never a guess.
 */
import { z } from 'zod'
import { macHelperPath, macHelperPresent, runHelperOnce } from './mac-helper'

const AX_SNAPSHOT_TIMEOUT_MS = 4_000
/** The AX write polls its readback for 0.5 s and a paste for 0.6 s; the rest is process start and slack. */
const AX_INSERT_TIMEOUT_MS = 8_000

const OPAQUE = /^[A-Za-z0-9_.:@-]{1,160}$/
const HEX_HASH = /^[0-9a-f]{64}$/

/** Swift's JSONEncoder omits a nil optional instead of writing null, so an absent key is null here. */
const nul = <T extends z.ZodType>(type: T) => type.nullish().transform((value) => value ?? null)

const SnapshotSchema = z.object({
  status: z.enum(['ok', 'permission', 'no_focus']),
  pid: nul(z.number().int().positive()),
  bundleId: nul(z.string().regex(OPAQUE)),
  processStartMs: nul(z.number().int().nonnegative()),
  windowId: nul(z.string().regex(OPAQUE)),
  role: nul(z.string().max(80)),
  subrole: nul(z.string().max(80)),
  token: nul(z.string().regex(OPAQUE)),
  secure: z.boolean(),
  editable: z.boolean(),
  terminal: z.boolean(),
  valueHash: nul(z.string().regex(HEX_HASH)),
  valueLength: nul(z.number().int().nonnegative()),
  valueTooLarge: z.boolean(),
  selection: nul(z.object({ location: z.number().int().nonnegative(), length: z.number().int().nonnegative() }))
})

export type AxFocusSnapshot = z.infer<typeof SnapshotSchema>

export const AX_REFUSAL_REASONS = [
  'secure_field',
  'target_changed',
  'permission',
  'unsupported',
  'invalid_request'
] as const
export type AxRefusalReason = (typeof AX_REFUSAL_REASONS)[number]

const InsertSchema = z.object({
  outcome: z.enum(['verified', 'unverified', 'refused', 'unsupported']),
  reason: nul(z.enum(AX_REFUSAL_REASONS)),
  method: z.enum(['ax', 'paste', 'none']),
  terminal: z.boolean(),
  sanitized: z.boolean(),
  textHash: nul(z.string().regex(HEX_HASH)),
  textLength: z.number().int().nonnegative(),
  clipboard: z.enum(['not_used', 'restored', 'kept_newer', 'left_unrestored'])
})

export type AxInsertResult = z.infer<typeof InsertSchema>

/** What `ax-insert` must still find in the field, and the text. The pid is one argv-free JSON number. */
export interface AxInsertRequest {
  pid: number
  /** The process start (ms) from the snapshot: a reused pid is a different process. */
  processStartMs: number
  windowId: string
  token: string
  valueHash: string
  valueLength: number
  selectionLocation: number
  selectionLength: number
  text: string
  allowPaste: boolean
}

export function macAxFocusSnapshotSpawnSpec(): { command: string; args: string[] } | null {
  return macHelperPresent() ? { command: macHelperPath(), args: ['ax-focus-snapshot'] } : null
}

export function macAxInsertSpawnSpec(): { command: string; args: string[] } | null {
  return macHelperPresent() ? { command: macHelperPath(), args: ['ax-insert'] } : null
}

/** Parse `ax-focus-snapshot` stdout; null for anything that is not the documented shape. */
export function parseAxFocusSnapshot(stdout: string): AxFocusSnapshot | null {
  try {
    return SnapshotSchema.parse(JSON.parse(stdout))
  } catch {
    return null
  }
}

/** Parse `ax-insert` stdout; null for anything that is not the documented shape. */
export function parseAxInsert(stdout: string): AxInsertResult | null {
  try {
    return InsertSchema.parse(JSON.parse(stdout))
  } catch {
    return null
  }
}

/** The JSON written to the helper's stdin. */
export function axInsertRequestBody(request: AxInsertRequest): string {
  return JSON.stringify({
    pid: request.pid,
    processStartMs: request.processStartMs,
    windowId: request.windowId,
    token: request.token,
    valueHash: request.valueHash,
    valueLength: request.valueLength,
    selectionLocation: request.selectionLocation,
    selectionLength: request.selectionLength,
    text: request.text,
    allowPaste: request.allowPaste
  })
}

/** The injectable face of the helper: the production client and the test fake both satisfy it. */
export interface AxHelperClient {
  snapshot(): Promise<AxFocusSnapshot | null>
  insert(request: AxInsertRequest): Promise<AxInsertResult | null>
}

export const macAxHelperClient: AxHelperClient = {
  snapshot: () => runHelperOnce(macAxFocusSnapshotSpawnSpec(), parseAxFocusSnapshot, AX_SNAPSHOT_TIMEOUT_MS),
  insert: (request) =>
    runHelperOnce(macAxInsertSpawnSpec(), parseAxInsert, AX_INSERT_TIMEOUT_MS, axInsertRequestBody(request))
}
