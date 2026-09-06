/**
 * Data retention (section 10): events 30 d, audit 365 d, asks 90 d, crm_sends 90 d, rate_limits 1 d,
 * plus closing sessions that stopped pulsing. Called from a daily cron trigger and, capped much
 * smaller, opportunistically on ingest so a Worker that never sees a cron still stays bounded.
 */

import type { OperatorStore } from './store'

const DAY_MS = 24 * 60 * 60 * 1000

export const RETENTION_MS = {
  events: 30 * DAY_MS,
  audit: 365 * DAY_MS,
  asks: 90 * DAY_MS,
  crm_sends: 90 * DAY_MS,
  rate_limits: 1 * DAY_MS
} as const

export interface RetentionCaps {
  events?: number
  audit?: number
  asks?: number
  crm_sends?: number
  rate_limits?: number
}

export interface RetentionResult {
  events: number
  audit: number
  asks: number
  crm_sends: number
  rate_limits: number
  staleSessionsClosed: number
}

/** Default cap per table per call: bounded so one cron tick (or one ingest request) never runs away. */
const DEFAULT_CAP = 200

export async function pruneRetention(store: OperatorStore, now: number, caps: RetentionCaps = {}): Promise<RetentionResult> {
  const events = await store.pruneTable('events', now - RETENTION_MS.events, caps.events ?? DEFAULT_CAP)
  const audit = await store.pruneTable('audit', now - RETENTION_MS.audit, caps.audit ?? DEFAULT_CAP)
  const asks = await store.pruneTable('asks', now - RETENTION_MS.asks, caps.asks ?? DEFAULT_CAP)
  const crm_sends = await store.pruneTable('crm_sends', now - RETENTION_MS.crm_sends, caps.crm_sends ?? DEFAULT_CAP)
  const rate_limits = await store.pruneTable('rate_limits', now - RETENTION_MS.rate_limits, caps.rate_limits ?? DEFAULT_CAP)
  const staleSessionsClosed = await store.closeStaleSessions(now)
  return { events, audit, asks, crm_sends, rate_limits, staleSessionsClosed }
}
