import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import {
  BRAIN_SCHEMA_VERSION,
  BrainIndexSchema,
  type BrainIndex,
  type IndexUnavailableCause
} from '@shared/brain'
import { decodeSavedResult, writeSaved } from '../../transcripts'
import { resolveMeetingsFolder } from './paths'

export type IngestLedgerMode = 'legacy' | 'expand' | 'switch'

export type IngestLedgerLoad =
  | { kind: 'ready'; index: BrainIndex }
  | { kind: 'absent' }
  | { kind: 'corrupt' }
  | { kind: 'unavailable'; cause: IndexUnavailableCause; detail?: string }

export type IngestLedgerResolved = {
  load: IngestLedgerLoad
  mtimeMs: number
  size: number
}

const FLAG_VALUES = new Map<string, IngestLedgerMode>([
  ['legacy', 'legacy'],
  ['off', 'legacy'],
  ['0', 'legacy'],
  ['false', 'legacy'],
  ['expand', 'expand'],
  ['1', 'expand'],
  ['true', 'expand'],
  ['switch', 'switch']
])

export function ingestLedgerMode(): IngestLedgerMode {
  const raw =
    process.env.ASKTOTO_LEDGER_USERDATA ??
    process.env.METIS_LEDGER_USERDATA ??
    process.env.ASKTOTO_FEATURE_LEDGER_USERDATA
  return FLAG_VALUES.get(String(raw ?? 'legacy').trim().toLowerCase()) ?? 'legacy'
}

export function userDataIngestLedgerPath(settings: Settings): string {
  const folderKey = createHash('sha256').update(resolveMeetingsFolder(settings)).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), 'brain', `index-${folderKey}.json`)
}

export function activeIngestLedgerPath(settings: Settings, legacyPath: string, mode = ingestLedgerMode()): string {
  return mode === 'switch' ? userDataIngestLedgerPath(settings) : legacyPath
}

export function classifyIngestLedgerBytes(buf: Buffer): IngestLedgerLoad {
  if (buf.length === 0) return { kind: 'absent' }
  const decoded = decodeSavedResult(buf)
  if (!decoded.ok) return { kind: 'unavailable', cause: 'undecryptable', detail: decoded.reason }
  let raw: unknown
  try {
    raw = JSON.parse(decoded.text)
  } catch {
    return { kind: 'corrupt' }
  }
  const v = (raw as { schema_version?: unknown } | null)?.schema_version
  if (typeof v === 'number' && v > BRAIN_SCHEMA_VERSION) return { kind: 'unavailable', cause: 'unsupported' }
  const parsed = BrainIndexSchema.safeParse(raw)
  if (parsed.success) return { kind: 'ready', index: parsed.data }
  return { kind: 'corrupt' }
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code
}

export async function readUserDataIngestLedger(settings: Settings): Promise<IngestLedgerResolved> {
  const p = userDataIngestLedgerPath(settings)
  let current: Awaited<ReturnType<typeof stat>>
  try {
    current = await stat(p)
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return { load: { kind: 'absent' }, mtimeMs: -1, size: -1 }
    return { load: { kind: 'unavailable', cause: 'io', detail: errnoCode(e) }, mtimeMs: -1, size: -1 }
  }
  try {
    return {
      load: classifyIngestLedgerBytes(await readFile(p)),
      mtimeMs: current.mtimeMs,
      size: current.size
    }
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return { load: { kind: 'absent' }, mtimeMs: -1, size: -1 }
    return { load: { kind: 'unavailable', cause: 'io', detail: errnoCode(e) }, mtimeMs: current.mtimeMs, size: current.size }
  }
}

export async function seedUserDataIngestLedgerFromLegacy(
  settings: Settings,
  legacyPath: string
): Promise<IngestLedgerResolved> {
  let legacyBytes: Buffer
  try {
    legacyBytes = await readFile(legacyPath)
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return { load: { kind: 'absent' }, mtimeMs: -1, size: -1 }
    return { load: { kind: 'unavailable', cause: 'io', detail: errnoCode(e) }, mtimeMs: -1, size: -1 }
  }
  const legacyLoad = classifyIngestLedgerBytes(legacyBytes)
  if (legacyLoad.kind !== 'ready') {
    const load = legacyLoad.kind === 'corrupt' ? { kind: 'unavailable', cause: 'corrupt-kept' } as const : legacyLoad
    return { load, mtimeMs: -1, size: -1 }
  }
  const userDataPath = userDataIngestLedgerPath(settings)
  try {
    await mkdir(dirname(userDataPath), { recursive: true })
    await writeSaved(userDataPath, JSON.stringify(legacyLoad.index, null, 2), !!settings.encryptTranscripts)
    const current = await stat(userDataPath)
    return { load: { kind: 'ready', index: legacyLoad.index }, mtimeMs: current.mtimeMs, size: current.size }
  } catch (e) {
    return { load: { kind: 'unavailable', cause: 'io', detail: errnoCode(e) }, mtimeMs: -1, size: -1 }
  }
}

export async function deleteUserDataIngestLedger(settings: Settings): Promise<void> {
  await rm(userDataIngestLedgerPath(settings), { force: true })
}

export function deleteUserDataIngestLedgerSync(settings: Settings): void {
  const current = userDataIngestLedgerPath(settings)
  rmSync(current, { force: true })
}

export function deleteUserDataIngestLedgersSync(settings: Settings): void {
  const current = userDataIngestLedgerPath(settings)
  deleteUserDataIngestLedgerSync(settings)
  const dir = dirname(current)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return
    throw e
  }
  for (const name of names) {
    if (/^index-[0-9a-f]{16}\.json$/i.test(name)) rmSync(join(dir, name), { force: true })
  }
}

export async function writeIngestLedger(settings: Settings, legacyPath: string, value: BrainIndex): Promise<void> {
  const mode = ingestLedgerMode()
  const body = JSON.stringify(value, null, 2)
  const userDataPath = userDataIngestLedgerPath(settings)
  if (mode === 'switch') {
    await mkdir(dirname(userDataPath), { recursive: true })
    await writeSaved(userDataPath, body, !!settings.encryptTranscripts)
    return
  }
  await mkdir(dirname(legacyPath), { recursive: true })
  if (mode === 'expand') {
    try {
      const mirror = classifyIngestLedgerBytes(await readFile(userDataPath))
      if (mirror.kind === 'unavailable') throw new Error(`userData ingest ledger is read-only (${mirror.cause})`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  await writeSaved(legacyPath, body, !!settings.encryptTranscripts)
  if (mode === 'expand') {
    await mkdir(dirname(userDataPath), { recursive: true })
    await writeSaved(userDataPath, body, !!settings.encryptTranscripts)
  }
}
