import { normalizeCrmRow, type CrmSendRow } from './crm'
import { mergeSeatLicenseLabel } from './fleet'
import { PRIVATE_EVENT_DETAIL_KINDS } from './privacy'
import { applyPulse, isSessionStale, type SessionRow as SessionState } from './sessions'
import type {
  AskRow,
  AuditQueryOpts,
  AuditRow,
  EventRow,
  EventsPage,
  EventsQueryOpts,
  GroupMemberRow,
  GroupRow,
  IntegrationGrantRow,
  IntegrationMeta,
  IntegrationRow,
  IssuedLicenseRow,
  OperatorStore,
  PackMeta,
  PackRow,
  ProposalRow,
  PulseRow,
  SeatRow,
  SessionDetail,
  SessionsPage,
  SessionsQueryOpts,
  TierRow,
  VaultKeyRow
} from './store'
import { toIntegrationMeta, toVaultMeta } from './store'

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
const SESSION_GAP_MS = 2 * 60 * 1000

/** Isolate-wide: once the live D1 proves it lacks asks.question_type, stop paying a failed insert per Ask. */
let askInsertLegacy = false
/** Isolate-wide: once the live D1 proves it lacks asks.path_tag, skip that column on later inserts. */
let askInsertNoPathTag = false

export function resetD1SchemaProbeForTests(): void {
  askInsertLegacy = false
  askInsertNoPathTag = false
}

/** SQLite / D1 phrasing for a column that is not in the table: "has no column named X" or "no such column: X". */
export function isMissingColumnError(e: unknown, column: string): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return new RegExp(`(no such column|has no column named)[:\\s]+${column}\\b`, 'i').test(msg)
}

function toBase64Url(raw: string): string {
  const bytes = new TextEncoder().encode(raw)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (padded.length % 4)) % 4
  const bin = atob(padded + '='.repeat(pad))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function encodeCursor(ts: number, id: string): string {
  return toBase64Url(`${ts}:${id}`)
}

function decodeCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null
  try {
    const raw = fromBase64Url(cursor)
    const i = raw.lastIndexOf(':')
    if (i < 0) return null
    const ts = Number(raw.slice(0, i))
    const id = raw.slice(i + 1)
    if (!Number.isFinite(ts) || !id) return null
    return { ts, id }
  } catch {
    return null
  }
}

export function d1Store(db: D1DatabaseLike): OperatorStore {
  async function listEventsImpl(limit: number): Promise<EventRow[]>
  async function listEventsImpl(limit: number, opts: EventsQueryOpts): Promise<EventsPage>
  async function listEventsImpl(limit: number, opts?: EventsQueryOpts): Promise<EventRow[] | EventsPage> {
    if (!opts) {
      const r = await db
        .prepare('SELECT id, ts, kind, actor, device_id, country, detail FROM events ORDER BY ts DESC LIMIT ?')
        .bind(limit)
        .all<EventRow>()
      return r.results
    }
    const pageLimit = opts.limit ?? limit
    const where: string[] = []
    const args: unknown[] = []
    if (opts.since != null) {
      where.push('e.ts >= ?')
      args.push(opts.since)
    }
    if (opts.until != null) {
      where.push('e.ts <= ?')
      args.push(opts.until)
    }
    if (opts.kinds && opts.kinds.length) {
      where.push(`e.kind IN (${opts.kinds.map(() => '?').join(',')})`)
      args.push(...opts.kinds)
    }
    if (opts.deviceId) {
      where.push('e.device_id = ?')
      args.push(opts.deviceId)
    }
    if (opts.country) {
      where.push('UPPER(COALESCE(e.country, s.country)) = ?')
      args.push(opts.country.toUpperCase())
    }
    if (opts.os) {
      where.push('LOWER(s.os) = ?')
      args.push(opts.os.toLowerCase())
    }
    if (opts.version) {
      where.push('s.app_version = ?')
      args.push(opts.version)
    }
    if (opts.q) {
      // Redacting the response after a raw-detail WHERE still exposes a search oracle. Apply the
      // same visibility policy in SQL before LIMIT/cursor selection, retaining operational detail.
      const visibleDetail = `CASE WHEN e.kind IN (${PRIVATE_EVENT_DETAIL_KINDS.map(() => '?').join(',')}) THEN NULL ELSE e.detail END`
      where.push(
        `(e.kind LIKE ? OR e.device_id LIKE ? OR e.country LIKE ? OR (${visibleDetail}) LIKE ? OR s.hostname LIKE ? OR s.sso_email LIKE ? OR s.os LIKE ? OR s.app_version LIKE ?)`
      )
      const like = `%${opts.q}%`
      args.push(like, like, like, ...PRIVATE_EVENT_DETAIL_KINDS, like, like, like, like, like)
    }
    const cursor = decodeCursor(opts.cursor)
    if (cursor) {
      where.push('(e.ts < ? OR (e.ts = ? AND e.id < ?))')
      args.push(cursor.ts, cursor.ts, cursor.id)
    }
    const sql = `SELECT e.id, e.ts, e.kind, e.actor, e.device_id, e.country, e.detail
                 FROM events e LEFT JOIN seats s ON s.device_id = e.device_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY e.ts DESC, e.id DESC LIMIT ?`
    args.push(pageLimit)
    const r = await db.prepare(sql).bind(...args).all<EventRow>()
    const rows = r.results
    const last = rows.at(-1)
    const nextCursor = rows.length === pageLimit && last ? encodeCursor(last.ts, last.id) : null
    return { rows, nextCursor }
  }

  async function openSessionFor(deviceId: string): Promise<SessionState | null> {
    return (
      (await db
        .prepare('SELECT * FROM sessions WHERE device_id = ? ORDER BY started_at DESC LIMIT 1')
        .bind(deviceId)
        .first<SessionState>()) ?? null
    )
  }

  async function writeSession(row: SessionState): Promise<void> {
    await db
      .prepare(
        `INSERT OR REPLACE INTO sessions (
          id, device_id, started_at, last_pulse_at, ended_at, pulses, asks, recaps, country, city, os, app_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.device_id,
        row.started_at,
        row.last_pulse_at,
        row.ended_at,
        row.pulses,
        row.asks,
        row.recaps,
        row.country,
        row.city,
        row.os,
        row.app_version
      )
      .run()
  }

  return {
    async takeNonce(nonce, ts) {
      const result = await db
        .prepare('INSERT INTO nonces (nonce, ts) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING')
        .bind(nonce, ts)
        .run() as { meta?: { changes?: number } }
      if (result?.meta?.changes !== 1) return true
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
        .prepare('SELECT first_seen, approval, license, license_jti FROM seats WHERE device_id = ?')
        .bind(row.device_id)
        .first<Pick<SeatRow, 'first_seen' | 'approval' | 'license' | 'license_jti'>>()
      const license = mergeSeatLicenseLabel(row.license, prev?.license, row.license_jti ?? prev?.license_jti)
      await db
        .prepare(
          `INSERT INTO seats (device_id, seat_hash, os, app_version, first_seen, last_seen, country, city, region, lat, lon, last_index_at, hostname, sso_email, license, approval, license_jti)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             seat_hash = excluded.seat_hash,
             os = CASE WHEN excluded.os IS NULL OR excluded.os = '' OR excluded.os = 'unknown' THEN seats.os ELSE excluded.os END,
             app_version = CASE WHEN excluded.app_version IS NULL OR excluded.app_version = '' THEN seats.app_version ELSE excluded.app_version END,
             last_seen = excluded.last_seen,
             country = COALESCE(excluded.country, seats.country),
             city = COALESCE(excluded.city, seats.city),
             region = COALESCE(excluded.region, seats.region),
             lat = COALESCE(excluded.lat, seats.lat),
             lon = COALESCE(excluded.lon, seats.lon),
             last_index_at = COALESCE(excluded.last_index_at, seats.last_index_at),
             hostname = COALESCE(excluded.hostname, seats.hostname),
             sso_email = COALESCE(excluded.sso_email, seats.sso_email),
             license = COALESCE(excluded.license, seats.license),
             license_jti = COALESCE(excluded.license_jti, seats.license_jti)`
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
          row.region ?? null,
          row.lat,
          row.lon,
          row.last_index_at,
          row.hostname,
          row.sso_email,
          license,
          row.approval || prev?.approval || 'pending',
          row.license_jti ?? null
        )
        .run()
    },
    async updateSeatApproval(deviceId, approval) {
      const existing = await db.prepare('SELECT device_id FROM seats WHERE device_id = ?').bind(deviceId).first<{ device_id: string }>()
      if (!existing) return false
      await db.prepare('UPDATE seats SET approval = ? WHERE device_id = ?').bind(approval, deviceId).run()
      return true
    },
    async getSeat(deviceId) {
      return (await db.prepare('SELECT * FROM seats WHERE device_id = ?').bind(deviceId).first<SeatRow>()) ?? null
    },
    async insertAsk(row) {
      const base = [
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
      ]
      // Fail-safe for a live D1 that has not had schema-alter.sql applied yet: the first insert that
      // trips "no such column" flips this isolate to the legacy statement, so an Ask is never dropped
      // because the fleet store is one migration behind. The type is lost for that row (null), which the
      // dashboard reports as coverage, never as a silent 100%.
      if (!askInsertLegacy && !askInsertNoPathTag) {
        try {
          await db
            .prepare(
              `INSERT OR REPLACE INTO asks (
                id, device_id, ts, mode, skill_id, skill_version, provider, model,
                ttft_ms, total_ms, input_tokens, output_tokens, cache_read, cache_write,
                cache_uncached, cache_status, cache_ttl, outcome, rating, prompt_cipher, prompt_iv, preview,
                question_type, path_tag
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(...base, row.question_type, row.path_tag ?? null)
            .run()
          return
        } catch (e) {
          if (isMissingColumnError(e, 'path_tag')) {
            askInsertNoPathTag = true
            console.warn(
              '[operator] asks.path_tag is missing on this D1. Apply operator/schema-alter.sql. Asks are stored without a path tag until then.'
            )
          } else if (!isMissingColumnError(e, 'question_type')) {
            throw e
          } else {
            askInsertLegacy = true
            console.warn(
              '[operator] asks.question_type is missing on this D1. Apply operator/schema-alter.sql. Asks are stored without a type until then.'
            )
          }
        }
      }
      if (!askInsertLegacy) {
        try {
          await db
            .prepare(
              `INSERT OR REPLACE INTO asks (
                id, device_id, ts, mode, skill_id, skill_version, provider, model,
                ttft_ms, total_ms, input_tokens, output_tokens, cache_read, cache_write,
                cache_uncached, cache_status, cache_ttl, outcome, rating, prompt_cipher, prompt_iv, preview,
                question_type
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(...base, row.question_type)
            .run()
          return
        } catch (e) {
          if (!isMissingColumnError(e, 'question_type')) throw e
          askInsertLegacy = true
          console.warn(
            '[operator] asks.question_type is missing on this D1. Apply operator/schema-alter.sql. Asks are stored without a type until then.'
          )
        }
      }
      await db
        .prepare(
          `INSERT OR REPLACE INTO asks (
            id, device_id, ts, mode, skill_id, skill_version, provider, model,
            ttft_ms, total_ms, input_tokens, output_tokens, cache_read, cache_write,
            cache_uncached, cache_status, cache_ttl, outcome, rating, prompt_cipher, prompt_iv, preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(...base)
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
    async listAsks(limit, since) {
      if (since != null) {
        const r = await db
          .prepare('SELECT * FROM asks WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
          .bind(since, limit)
          .all<AskRow>()
        return r.results
      }
      const r = await db.prepare('SELECT * FROM asks ORDER BY ts DESC LIMIT ?').bind(limit).all<AskRow>()
      return r.results
    },
    async getAsk(id) {
      return (await db.prepare('SELECT * FROM asks WHERE id = ?').bind(id).first<AskRow>()) ?? null
    },
    async listSeats() {
      const r = await db.prepare('SELECT * FROM seats').all<SeatRow>()
      return r.results.map((s) => ({
        ...s,
        hostname: s.hostname ?? null,
        sso_email: s.sso_email ?? null,
        license: s.license ?? null,
        approval: s.approval ?? null,
        license_jti: s.license_jti ?? null,
        region: s.region ?? null
      }))
    },
    async insertPulse(row) {
      await db
        .prepare('INSERT OR REPLACE INTO pulses (id, device_id, ts, kind, country, city, region) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.device_id, row.ts, row.kind, row.country, row.city, row.region ?? null)
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
    async listProposals(limit) {
      if (limit != null) {
        const r = await db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?').bind(limit).all<ProposalRow>()
        return r.results
      }
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
      const r = await db
        .prepare('SELECT id, skill_id, version, sha256, signed, pushed_at, pushed_by FROM packs')
        .all<PackMeta>()
      return r.results
    },
    async latestPacks() {
      const r = await db
        .prepare('SELECT id, skill_id, version, sha256, signed, pushed_at, pushed_by FROM packs ORDER BY pushed_at DESC')
        .all<PackMeta>()
      const by = new Map<string, PackMeta>()
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
    async audit(id, ts, actor, action, askId, detail, meta) {
      await db
        .prepare('INSERT INTO audit (id, ts, actor, action, ask_id, detail, request_id, route) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ts, actor, action, askId, detail, meta?.requestId ?? null, meta?.route ?? null)
        .run()
    },
    async listAudit(limit, opts) {
      const where: string[] = []
      const args: unknown[] = []
      if (opts?.since != null) {
        where.push('ts >= ?')
        args.push(opts.since)
      }
      if (opts?.actor) {
        where.push('actor = ?')
        args.push(opts.actor)
      }
      if (opts?.action) {
        where.push('action = ?')
        args.push(opts.action)
      }
      const sql = `SELECT ts, actor, action, ask_id, detail, request_id, route FROM audit
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY ts DESC LIMIT ?`
      args.push(limit)
      const r = await db.prepare(sql).bind(...args).all<AuditRow>()
      return r.results.map((row) => ({ ...row, request_id: row.request_id ?? null, route: row.route ?? null }))
    },
    async insertEvent(row) {
      await db
        .prepare(
          'INSERT OR REPLACE INTO events (id, ts, kind, actor, device_id, country, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(row.id, row.ts, row.kind, row.actor, row.device_id, row.country, row.detail)
        .run()
    },
    listEvents: listEventsImpl,
    async countEventsByKind(since, until) {
      const r = await db
        .prepare('SELECT kind, COUNT(*) as n FROM events WHERE ts >= ? AND ts <= ? GROUP BY kind')
        .bind(since, until)
        .all<{ kind: string; n: number }>()
      const out: Record<string, number> = {}
      for (const row of r.results) out[row.kind] = row.n
      return out
    },
    async listVaultMeta() {
      const r = await db
        .prepare(
          `SELECT id, provider, label, last4, cipher, iv, status, created_at, created_by, rotated_at, revoked_at
           FROM vault_keys ORDER BY created_at DESC`
        )
        .all<VaultKeyRow>()
      return r.results.map(toVaultMeta)
    },
    async listVaultRows() {
      const r = await db
        .prepare(
          `SELECT id, provider, label, last4, cipher, iv, status, created_at, created_by, rotated_at, revoked_at
           FROM vault_keys ORDER BY created_at DESC`
        )
        .all<VaultKeyRow>()
      return r.results
    },
    async getVaultKey(id) {
      return (
        (await db
          .prepare(
            `SELECT id, provider, label, last4, cipher, iv, status, created_at, created_by, rotated_at, revoked_at
             FROM vault_keys WHERE id = ?`
          )
          .bind(id)
          .first<VaultKeyRow>()) ?? null
      )
    },
    async putVaultKey(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO vault_keys (
            id, provider, label, last4, cipher, iv, status, created_at, created_by, rotated_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id,
          row.provider,
          row.label,
          row.last4,
          row.cipher,
          row.iv,
          row.status,
          row.created_at,
          row.created_by,
          row.rotated_at,
          row.revoked_at
        )
        .run()
    },
    async supersedeActiveVaultKeys(provider, exceptId, now) {
      await db
        .prepare(
          `UPDATE vault_keys SET status = 'superseded', cipher = '', iv = '', rotated_at = ?
           WHERE provider = ? AND id != ? AND status = 'active'`
        )
        .bind(now, provider, exceptId)
        .run()
    },
    async clearVaultSecret(id) {
      await db.prepare(`UPDATE vault_keys SET cipher = '', iv = '' WHERE id = ?`).bind(id).run()
    },
    async putIssuedLicense(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO issued_licenses (
            jti, last4, key_hash, days, iat, exp, revoked, created_at, created_by,
            group_id, tier, member, activated_device, activated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.jti,
          row.last4,
          row.key_hash,
          row.days,
          row.iat,
          row.exp,
          row.revoked,
          row.created_at,
          row.created_by,
          row.group_id ?? null,
          row.tier ?? null,
          row.member ?? null,
          row.activated_device ?? null,
          row.activated_at ?? null
        )
        .run()
    },
    async getIssuedLicense(jti) {
      return (await db.prepare('SELECT * FROM issued_licenses WHERE jti = ?').bind(jti).first<IssuedLicenseRow>()) ?? null
    },
    async listIssuedLicenses(limit) {
      if (limit != null) {
        const r = await db
          .prepare('SELECT * FROM issued_licenses ORDER BY created_at DESC LIMIT ?')
          .bind(limit)
          .all<IssuedLicenseRow>()
        return r.results
      }
      const r = await db.prepare('SELECT * FROM issued_licenses ORDER BY created_at DESC').all<IssuedLicenseRow>()
      return r.results
    },
    async updateIssuedLicense(jti, patch) {
      const existing = await db.prepare('SELECT jti FROM issued_licenses WHERE jti = ?').bind(jti).first<{ jti: string }>()
      if (!existing) return false
      const fields = Object.keys(patch) as (keyof IssuedLicenseRow)[]
      if (!fields.length) return true
      const set = fields.map((f) => `${f} = ?`).join(', ')
      const args = fields.map((f) => patch[f] ?? null)
      await db
        .prepare(`UPDATE issued_licenses SET ${set} WHERE jti = ?`)
        .bind(...args, jti)
        .run()
      return true
    },
    async bindIssuedLicense(jti, keyHash, deviceId, now) {
      const result = await db
        .prepare(
          `UPDATE issued_licenses SET activated_device = ?, activated_at = COALESCE(activated_at, ?)
           WHERE jti = ? AND key_hash = ? AND revoked = 0 AND exp > ?
             AND (activated_device IS NULL OR activated_device = '' OR activated_device = ?)
             AND NOT EXISTS (
               SELECT 1 FROM seats WHERE device_id = ? AND LOWER(TRIM(COALESCE(approval, ''))) = 'revoked'
             )`
        )
        .bind(deviceId, now, jti, keyHash, now / 1000, deviceId, deviceId)
        .run() as { meta?: { changes?: number } }
      return result?.meta?.changes === 1
    },
    async revokeIssuedLicense(jti, now) {
      const existing = await db
        .prepare('SELECT jti, activated_at FROM issued_licenses WHERE jti = ?')
        .bind(jti)
        .first<{ jti: string; activated_at: number | null }>()
      if (!existing) return false
      await db
        .prepare('UPDATE issued_licenses SET revoked = 1, activated_at = COALESCE(activated_at, ?) WHERE jti = ?')
        .bind(now, jti)
        .run()
      return true
    },
    async touchSession(deviceId, ts, kind, geo, seatMeta) {
      const existing = await openSessionFor(deviceId)
      const { session, closed } = applyPulse(
        existing,
        { deviceId, ts, kind, country: geo.country, city: geo.city, os: seatMeta.os, appVersion: seatMeta.app_version },
        () => crypto.randomUUID()
      )
      if (closed) await writeSession(closed)
      await writeSession(session)
      return session
    },
    async listSessions(opts: SessionsQueryOpts): Promise<SessionsPage> {
      const where: string[] = []
      const args: unknown[] = []
      if (opts.since != null) {
        where.push('started_at >= ?')
        args.push(opts.since)
      }
      if (opts.until != null) {
        where.push('started_at <= ?')
        args.push(opts.until)
      }
      if (opts.deviceId) {
        where.push('device_id = ?')
        args.push(opts.deviceId)
      }
      const cursor = decodeCursor(opts.cursor)
      if (cursor) {
        where.push('(started_at < ? OR (started_at = ? AND id < ?))')
        args.push(cursor.ts, cursor.ts, cursor.id)
      }
      const limit = opts.limit > 0 ? opts.limit : 50
      const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`
      args.push(limit)
      const r = await db.prepare(sql).bind(...args).all<SessionState>()
      const rows = r.results
      const last = rows.at(-1)
      const nextCursor = rows.length === limit && last ? encodeCursor(last.started_at, last.id) : null
      return { rows, nextCursor }
    },
    async getSession(id): Promise<SessionDetail | null> {
      const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<SessionState>()
      if (!session) return null
      const end = session.ended_at ?? session.last_pulse_at
      const r = await db
        .prepare('SELECT * FROM pulses WHERE device_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
        .bind(session.device_id, session.started_at, end)
        .all<PulseRow>()
      return { session, pulses: r.results }
    },
    async closeStaleSessions(now) {
      const r = await db
        .prepare('SELECT id, last_pulse_at, ended_at FROM sessions WHERE ended_at IS NULL')
        .all<{ id: string; last_pulse_at: number; ended_at: number | null }>()
      let n = 0
      for (const row of r.results) {
        if (!isSessionStale(row, now, SESSION_GAP_MS)) continue
        await db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').bind(row.last_pulse_at, row.id).run()
        n++
      }
      return n
    },
    async listGroups() {
      const r = await db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all<GroupRow>()
      return r.results
    },
    async getGroup(id) {
      return (await db.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first<GroupRow>()) ?? null
    },
    async putGroup(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO groups (id, name, tier, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(row.id, row.name, row.tier, row.notes, row.created_at, row.created_by)
        .run()
    },
    async deleteGroup(id) {
      await db.prepare('DELETE FROM group_members WHERE group_id = ?').bind(id).run()
      await db.prepare('DELETE FROM groups WHERE id = ?').bind(id).run()
    },
    async listGroupMembers(groupId) {
      const r = await db
        .prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY added_at ASC')
        .bind(groupId)
        .all<GroupMemberRow>()
      return r.results
    },
    async putGroupMember(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO group_members (group_id, member, kind, added_at, added_by) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(row.group_id, row.member, row.kind, row.added_at, row.added_by)
        .run()
    },
    async deleteGroupMember(groupId, member) {
      await db.prepare('DELETE FROM group_members WHERE group_id = ? AND member = ?').bind(groupId, member).run()
    },
    async listTiers() {
      const r = await db.prepare('SELECT * FROM tiers ORDER BY id ASC').all<TierRow>()
      return r.results
    },
    async putTier(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO tiers (id, label, entitlements_json, updated_at) VALUES (?, ?, ?, ?)`
        )
        .bind(row.id, row.label, row.entitlements_json, row.updated_at)
        .run()
    },
    async listIntegrationsMeta() {
      const r = await db
        .prepare(
          `SELECT id, kind, label, base_url, last4, scope_json, status, created_at, created_by, rotated_at, revoked_at, last_used_at, uses
           FROM integrations ORDER BY created_at DESC`
        )
        .all<IntegrationMeta>()
      return r.results
    },
    async listIntegrationRows() {
      const r = await db.prepare('SELECT * FROM integrations ORDER BY created_at DESC').all<IntegrationRow>()
      return r.results
    },
    async getIntegration(id) {
      return (await db.prepare('SELECT * FROM integrations WHERE id = ?').bind(id).first<IntegrationRow>()) ?? null
    },
    async putIntegration(row) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO integrations (
            id, kind, label, base_url, cipher, iv, last4, scope_json, status,
            created_at, created_by, rotated_at, revoked_at, last_used_at, uses
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id,
          row.kind,
          row.label,
          row.base_url,
          row.cipher,
          row.iv,
          row.last4,
          row.scope_json,
          row.status,
          row.created_at,
          row.created_by,
          row.rotated_at,
          row.revoked_at,
          row.last_used_at,
          row.uses
        )
        .run()
    },
    async insertIntegrationGrant(row) {
      await db
        .prepare('INSERT OR REPLACE INTO integration_grants (id, integration_id, device_id, ts) VALUES (?, ?, ?, ?)')
        .bind(row.id, row.integration_id, row.device_id, row.ts)
        .run()
    },
    async listIntegrationGrants(integrationId, limit) {
      const r = await db
        .prepare('SELECT * FROM integration_grants WHERE integration_id = ? ORDER BY ts DESC LIMIT ?')
        .bind(integrationId, limit)
        .all<IntegrationGrantRow>()
      return r.results
    },
    async bumpIntegrationUse(id, now) {
      await db.prepare('UPDATE integrations SET uses = uses + 1, last_used_at = ? WHERE id = ?').bind(now, id).run()
    },
    async pruneTable(table, before, cap) {
      const column = table === 'rate_limits' ? 'window_start' : 'ts'
      const idColumn = table === 'rate_limits' ? 'device_id' : 'id'
      const r = await db
        .prepare(`SELECT ${idColumn} as id FROM ${table} WHERE ${column} < ? LIMIT ?`)
        .bind(before, cap)
        .all<{ id: string }>()
      if (!r.results.length) return 0
      for (const row of r.results) {
        await db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(row.id).run()
      }
      return r.results.length
    }
  }
}

export { toIntegrationMeta }
