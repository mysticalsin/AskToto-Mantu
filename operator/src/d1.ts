import { normalizeCrmRow, type CrmSendRow } from './crm'
import type { AskRow, OperatorStore, PackRow, ProposalRow, PulseRow, SeatRow } from './store'

interface D1Stmt {
  bind(...values: unknown[]): D1Stmt
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface D1DatabaseLike {
  prepare(query: string): D1Stmt
}

const NONCE_TTL_MS = 10 * 60 * 1000
const PULSE_TTL_MS = 8 * 24 * 60 * 60 * 1000

export function d1Store(db: D1DatabaseLike): OperatorStore {
  return {
    async takeNonce(nonce, ts) {
      const existing = await db.prepare('SELECT nonce FROM nonces WHERE nonce = ?').bind(nonce).first<{ nonce: string }>()
      if (existing) return true
      await db.prepare('INSERT INTO nonces (nonce, ts) VALUES (?, ?)').bind(nonce, ts).run()
      await db.prepare('DELETE FROM nonces WHERE ts < ?').bind(ts - NONCE_TTL_MS).run()
      return false
    },
    async hitRate(deviceId, now, windowMs, max) {
      const cur = await db
        .prepare('SELECT window_start, count FROM rate_limits WHERE device_id = ?')
        .bind(deviceId)
        .first<{ window_start: number; count: number }>()
      if (!cur || now - cur.window_start > windowMs) {
        await db
          .prepare(
            'INSERT INTO rate_limits (device_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(device_id) DO UPDATE SET window_start = ?, count = 1'
          )
          .bind(deviceId, now, now)
          .run()
        return false
      }
      const next = cur.count + 1
      await db.prepare('UPDATE rate_limits SET count = ? WHERE device_id = ?').bind(next, deviceId).run()
      return next > max
    },
    async upsertSeat(row) {
      const prev = await db
        .prepare('SELECT first_seen, country, city, lat, lon, last_index_at FROM seats WHERE device_id = ?')
        .bind(row.device_id)
        .first<Pick<SeatRow, 'first_seen' | 'country' | 'city' | 'lat' | 'lon' | 'last_index_at'>>()
      await db
        .prepare(
          `INSERT INTO seats (device_id, seat_hash, os, app_version, first_seen, last_seen, country, city, lat, lon, last_index_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             seat_hash = excluded.seat_hash,
             os = excluded.os,
             app_version = excluded.app_version,
             last_seen = excluded.last_seen,
             country = COALESCE(excluded.country, seats.country),
             city = COALESCE(excluded.city, seats.city),
             lat = COALESCE(excluded.lat, seats.lat),
             lon = COALESCE(excluded.lon, seats.lon),
             last_index_at = COALESCE(excluded.last_index_at, seats.last_index_at)`
        )
        .bind(
          row.device_id,
          row.seat_hash,
          row.os,
          row.app_version,
          prev?.first_seen ?? row.first_seen,
          row.last_seen,
          row.country,
          row.city,
          row.lat,
          row.lon,
          row.last_index_at
        )
        .run()
    },
    async insertAsk(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO asks (
            id, device_id, ts, mode, skill_id, skill_version, provider, model,
            ttft_ms, total_ms, input_tokens, output_tokens, cache_read, cache_write,
            cache_uncached, cache_status, cache_ttl, outcome, rating, prompt_cipher, prompt_iv, preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id,
          row.device_id,
          row.ts,
          row.mode,
          row.skill_id,
          row.skill_version,
          row.provider,
          row.model,
          row.ttft_ms,
          row.total_ms,
          row.input_tokens,
          row.output_tokens,
          row.cache_read,
          row.cache_write,
          row.cache_uncached,
          row.cache_status,
          row.cache_ttl,
          row.outcome,
          row.rating,
          row.prompt_cipher,
          row.prompt_iv,
          row.preview
        )
        .run()
    },
    async updateAskRating(id, rating) {
      const outcome = rating === 'down' ? 'thumbs-down' : null
      if (outcome) {
        await db.prepare('UPDATE asks SET rating = ?, outcome = ? WHERE id = ?').bind(rating, outcome, id).run()
      } else {
        await db.prepare('UPDATE asks SET rating = ? WHERE id = ?').bind(rating, id).run()
      }
    },
    async listAsks(limit) {
      const r = await db.prepare('SELECT * FROM asks ORDER BY ts DESC LIMIT ?').bind(limit).all<AskRow>()
      return r.results
    },
    async getAsk(id) {
      return (await db.prepare('SELECT * FROM asks WHERE id = ?').bind(id).first<AskRow>()) ?? null
    },
    async listSeats() {
      const r = await db.prepare('SELECT * FROM seats').all<SeatRow>()
      return r.results
    },
    async insertPulse(row) {
      await db
        .prepare('INSERT OR REPLACE INTO pulses (id, device_id, ts, kind, country, city) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.device_id, row.ts, row.kind, row.country, row.city)
        .run()
      await db.prepare('DELETE FROM pulses WHERE ts < ?').bind(row.ts - PULSE_TTL_MS).run()
    },
    async listPulses(since) {
      const r = await db
        .prepare('SELECT * FROM pulses WHERE ts >= ? ORDER BY ts ASC')
        .bind(since)
        .all<PulseRow>()
      return r.results
    },
    async listProposals() {
      const r = await db.prepare('SELECT * FROM proposals ORDER BY created_at DESC').all<ProposalRow>()
      return r.results
    },
    async getProposal(id) {
      return (await db.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first<ProposalRow>()) ?? null
    },
    async putProposal(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO proposals (
            id, skill_id, from_version, evidence_json, diff, rationale, status,
            created_by, created_at, decided_at, reject_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id,
          row.skill_id,
          row.from_version,
          row.evidence_json,
          row.diff,
          row.rationale,
          row.status,
          row.created_by,
          row.created_at,
          row.decided_at,
          row.reject_reason
        )
        .run()
    },
    async listPacks() {
      const r = await db.prepare('SELECT * FROM packs').all<PackRow>()
      return r.results
    },
    async latestPacks() {
      const r = await db.prepare('SELECT * FROM packs ORDER BY pushed_at DESC').all<PackRow>()
      const by = new Map<string, PackRow>()
      for (const p of r.results) {
        if (!by.has(p.skill_id)) by.set(p.skill_id, p)
      }
      return [...by.values()]
    },
    async putPack(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO packs (
            id, skill_id, version, sha256, body, signed, pushed_at, pushed_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(row.id, row.skill_id, row.version, row.sha256, row.body, row.signed, row.pushed_at, row.pushed_by)
        .run()
    },
    async upsertCrm(row) {
      await db
        .prepare(
          `INSERT INTO crm_sends (
             id, device_id, ts, status, title, connector, meeting_file, meeting_hash,
             last_error, retry_requested, attempt, latency_ms, remote_id, remote_url, action
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ts = excluded.ts,
             status = excluded.status,
             title = excluded.title,
             connector = excluded.connector,
             meeting_file = excluded.meeting_file,
             meeting_hash = excluded.meeting_hash,
             last_error = excluded.last_error,
             retry_requested = excluded.retry_requested,
             attempt = excluded.attempt,
             latency_ms = excluded.latency_ms,
             remote_id = excluded.remote_id,
             remote_url = excluded.remote_url,
             action = excluded.action`
        )
        .bind(
          row.id,
          row.device_id,
          row.ts,
          row.status,
          row.title,
          row.connector,
          row.meeting_file,
          row.meeting_hash,
          row.last_error,
          row.retry_requested,
          row.attempt,
          row.latency_ms,
          row.remote_id,
          row.remote_url,
          row.action
        )
        .run()
    },
    async getCrm(id) {
      const row = await db.prepare('SELECT * FROM crm_sends WHERE id = ?').bind(id).first<CrmSendRow>()
      return row ? normalizeCrmRow(row) : null
    },
    async listCrm(limit) {
      const r = await db.prepare('SELECT * FROM crm_sends ORDER BY ts DESC LIMIT ?').bind(limit).all<CrmSendRow>()
      return r.results.map(normalizeCrmRow)
    },
    async listCrmRetries(deviceId) {
      const r = await db
        .prepare(
          `SELECT * FROM crm_sends
           WHERE device_id = ? AND retry_requested = 1 AND status IN ('pending', 'failed', 'expired')`
        )
        .bind(deviceId)
        .all<CrmSendRow>()
      return r.results.map(normalizeCrmRow)
    },
    async audit(id, ts, actor, action, askId, detail) {
      await db
        .prepare('INSERT INTO audit (id, ts, actor, action, ask_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, ts, actor, action, askId, detail)
        .run()
    },
    async listAudit(limit) {
      const r = await db
        .prepare('SELECT ts, actor, action, ask_id, detail FROM audit ORDER BY ts DESC LIMIT ?')
        .bind(limit)
        .all<{ ts: number; actor: string; action: string; ask_id: string | null; detail: string }>()
      return r.results
    }
  }
}
