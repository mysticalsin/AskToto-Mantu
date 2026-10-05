import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import { getSettings } from '../store'
import { loadJson, readJson, writeJson } from './store'

export const INTELLIGENCE_INDEX_STATE_FILE = 'intelligence-index.json'

const StateSchema = z.object({
  lastSuccessAt: z.number().nonnegative(),
  /** When the last pass ended, success or failure. */
  lastFinishedAt: z.number().nonnegative().optional(),
  lastError: z.string().optional()
})
export type IntelligenceIndexState = z.infer<typeof StateSchema>

export function readIntelligenceIndexState(s: Settings = getSettings()): IntelligenceIndexState {
  const v = readJson<IntelligenceIndexState>(s, INTELLIGENCE_INDEX_STATE_FILE, (raw) => StateSchema.parse(raw))
  return v ?? { lastSuccessAt: 0 }
}

export async function loadIntelligenceIndexState(s: Settings = getSettings()): Promise<IntelligenceIndexState> {
  const loaded = await loadJson<IntelligenceIndexState>(s, INTELLIGENCE_INDEX_STATE_FILE, (raw) => StateSchema.parse(raw))
  return loaded.status === 'ok' && loaded.value ? loaded.value : { lastSuccessAt: 0 }
}

export async function writeIntelligenceIndexState(
  next: IntelligenceIndexState,
  s: Settings = getSettings()
): Promise<void> {
  await writeJson(s, INTELLIGENCE_INDEX_STATE_FILE, next)
}

export function lastIndexedAt(s: Settings = getSettings()): number | undefined {
  const at = readIntelligenceIndexState(s).lastSuccessAt
  return at > 0 ? at : undefined
}

export async function lastIndexedAtAsync(s: Settings = getSettings()): Promise<number | undefined> {
  const at = (await loadIntelligenceIndexState(s)).lastSuccessAt
  return at > 0 ? at : undefined
}
