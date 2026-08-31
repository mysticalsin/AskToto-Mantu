/**
 * time-saved-log.ts — append-only local event log for honest time-saved sensors.
 *
 * File: <userData>/time-saved.jsonl
 * One JSON object per line. Never rewritten. A read that hits a corrupt line skips that line
 * rather than inventing totals. Fail closed on write: the caller gets { ok: false }, the UI
 * does not mint a fake minute to stay pretty.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  TIME_SAVED_CONNECTORS,
  TIME_SAVED_EVENT_KINDS,
  totalsFromEvents,
  type TimeSavedConnector,
  type TimeSavedEvent,
  type TimeSavedEventKind,
  type TimeSavedEventTotals
} from '@shared/time-saved-events'
import { auditLog, mainLog } from './logger'

const KINDS = new Set<string>(TIME_SAVED_EVENT_KINDS)
const CONNECTORS = new Set<string>(TIME_SAVED_CONNECTORS)

export function timeSavedLogPath(): string {
  return join(app.getPath('userData'), 'time-saved.jsonl')
}

function isEvent(v: unknown): v is TimeSavedEvent {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  if (!KINDS.has(String(e.kind))) return false
  if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) return false
  if (typeof e.estimatedMinutes !== 'number' || !Number.isFinite(e.estimatedMinutes) || e.estimatedMinutes < 0) {
    return false
  }
  if (e.connector != null && !CONNECTORS.has(String(e.connector))) return false
  return true
}

export function parseTimeSavedLine(line: string): TimeSavedEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function readTimeSavedEvents(filePath = timeSavedLogPath()): TimeSavedEvent[] {
  if (!existsSync(filePath)) return []
  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (e) {
    mainLog.warn('[time-saved] could not read event log', e instanceof Error ? e.message : String(e))
    return []
  }
  const out: TimeSavedEvent[] = []
  for (const line of raw.split('\n')) {
    const ev = parseTimeSavedLine(line)
    if (ev) out.push(ev)
  }
  return out
}

export function summarizeTimeSaved(filePath = timeSavedLogPath()): TimeSavedEventTotals & { recent: TimeSavedEvent[] } {
  const events = readTimeSavedEvents(filePath)
  return { ...totalsFromEvents(events), recent: events.slice(-8).reverse() }
}

export function appendTimeSavedEvent(
  event: Omit<TimeSavedEvent, 'timestamp'> & { timestamp?: number },
  filePath?: string
): { ok: true; event: TimeSavedEvent } | { ok: false; error: string } {
  const kind = event.kind as TimeSavedEventKind
  if (!KINDS.has(kind)) return { ok: false, error: 'Unknown time-saved event kind.' }
  const estimatedMinutes =
    Number.isFinite(event.estimatedMinutes) && event.estimatedMinutes > 0 ? event.estimatedMinutes : 0
  if (estimatedMinutes <= 0) return { ok: false, error: 'Refusing to record a zero or invented estimate.' }
  const connector = (event.connector ?? 'none') as TimeSavedConnector
  if (!CONNECTORS.has(connector)) return { ok: false, error: 'Unknown connector.' }
  const record: TimeSavedEvent = {
    kind,
    timestamp: event.timestamp ?? Date.now(),
    estimatedMinutes,
    connector,
    ids: event.ids
  }
  try {
    const dest = filePath ?? timeSavedLogPath()
    mkdirSync(dirname(dest), { recursive: true })
    appendFileSync(dest, `${JSON.stringify(record)}\n`, 'utf8')
    auditLog('time-saved.event', {
      kind: record.kind,
      estimatedMinutes: record.estimatedMinutes,
      connector: record.connector
    })
    return { ok: true, event: record }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not write the time-saved log.'
    mainLog.warn('[time-saved] append failed', msg)
    return { ok: false, error: `Could not write the time-saved log. ${msg}` }
  }
}
