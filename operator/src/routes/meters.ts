/**
 * Admin usage-meter routes (G81, CAP-34, D-16). Both live under `/v1/admin/*`, so they inherit the Access identity
 * check, the CSRF gate and the admin mutation rate limit from `index.ts`. Per-device aggregates only: no prompt,
 * preview, model or cipher. The budget itself is changed through `PATCH /v1/admin/settings.json` (owner-only).
 *
 *   GET  /v1/admin/meters.json?day=<utc-midnight ms>   reconciled rows for the day (default today) plus the limit
 *   POST /v1/admin/meters/reconcile  {day}             recompute that day from `asks`; audited as `meters.reconcile`
 */
import { json } from '../http'
import { readDailyBudget, utcMidnight } from '../meters'
import { listUsageDay, reconcileUsageDay, validUsageDay } from '../usage-reconcile'
import { auditLog, type AdminCtx } from './admin-ctx'
import { defineRoute } from './registry'

export function registerMetersRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/meters.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const raw = ctx.url.searchParams.get('day')
      const day = raw === null ? utcMidnight(ctx.now) : Number(raw)
      if (raw !== null && (raw.trim() === '' || !validUsageDay(day, ctx.now)))
        return json({ ok: false, error: 'invalid day' }, 400)
      if (!ctx.env.DB) return json({ ok: false, error: 'db unbound' }, 503)
      try {
        const rows = await listUsageDay(ctx.env.DB, day)
        return json({ ok: true, day, limit: await readDailyBudget(ctx.store), rows })
      } catch {
        return json({ ok: false, error: 'not migrated' }, 503)
      }
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/meters/reconcile',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as { day?: unknown }
      const day = typeof body.day === 'number' ? body.day : Number.NaN
      const result = await reconcileUsageDay(ctx.env.DB, day, ctx.now)
      if (!result.ok) {
        const status = result.error === 'invalid day' ? 400 : 503
        return json({ ok: false, error: result.error }, status)
      }
      await auditLog(ctx, 'meters.reconcile', null, `day ${result.day} seats ${result.seats} drift ${result.drift}`)
      return json(result)
    }
  })
}
