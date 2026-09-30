import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import {
  BRAIN_SCHEMA_VERSION,
  BrainIndexSchema,
  type BrainIndex,
  type IndexUnavailableCause
} from '@shared/brain'
import { decodeSavedResult, writeSaved } from '../../transcripts'

export type IngestLedgerMode = 'legacy' | 'expand' | 'switch'

export type IngestLedgerLoad =
  | { kind: 'ready'; index: BrainIndex }
  | { kind: 'absent' }
  | { kind: 'corrupt' }
  | { kind: 'unavailable'; cause: IndexUnavailableCause; detail?: string }

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

export function userDataIngestLedgerPath(): string {
  return join(app.getPath('userData'), 'brain', 'index.json')
}

export function activeIngestLedgerPath(legacyPath: string, mode = ingestLedgerMode()): string {
  return mode === 'switch' ? userDataIngestLedgerPath() : legacyPath
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

export async function writeIngestLedger(settings: Settings, legacyPath: string, value: BrainIndex): Promise<void> {
  const mode = ingestLedgerMode()
  const body = JSON.stringify(value, null, 2)
  const userDataPath = userDataIngestLedgerPath()
  if (mode === 'switch') {
    await mkdir(dirname(userDataPath), { recursive: true })
    await writeSaved(userDataPath, body, !!settings.encryptTranscripts)
    return
  }
  await mkdir(dirname(legacyPath), { recursive: true })
  await writeSaved(legacyPath, body, !!settings.encryptTranscripts)
  if (mode === 'expand') {
    await mkdir(dirname(userDataPath), { recursive: true })
    await writeSaved(userDataPath, body, !!settings.encryptTranscripts)
  }
}
