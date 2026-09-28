/**
 * Fleet model policy routes (M2-0412).
 *
 * Admin console: `GET`/`PUT /v1/admin/model-policy.json`, owner-role only for the mutation (every
 * admin may read; only an `OWNER_EMAILS` address may write) — the Models page shows a read-only
 * view to a non-owner admin and the edit form to the owner. Every write is audited with a
 * before/after snapshot, matching `settings-store.ts`.
 *
 * Device-facing: `GET /v1/model-policy`, device-HMAC-authenticated the same way `/v1/integrations`
 * is (dispatched directly from `index.ts`'s device block, not through the `defineRoute` admin
 * registry). Returns the current policy signed with whatever secret this exact request just proved
 * it holds (the fleet ingest secret, or — for a licensed seat — that seat's own license token), so
 * the caller can verify the signature completely offline using a secret it already has, per the
 * ticket's explicit guidance to reuse the existing seat/desktop-license device authentication.
 */
import { OPERATOR_LICENSE_HEADER } from '../../../src/shared/operator-hmac'
import { ModelPolicyDocumentSchema } from '../../../src/shared/model-policy'
import { isAdminEmail, isOwnerEmail } from '../access'
import { auditLog, safeAuditText, type AdminCtx } from './admin-ctx'
import { defineRoute } from './registry'
import { json } from '../http'
import type { OperatorStore } from '../store'
import { readModelPolicy, signModelPolicy, writeModelPolicy } from '../model-policy'

export function registerModelPolicyRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/model-policy.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const policy = await readModelPolicy(ctx.env.DB)
      return json({ ok: true, policy, isOwner: isOwnerEmail(ctx.email, ctx.env) })
    }
  })
  defineRoute<AdminCtx>({
    method: 'PUT',
    pattern: '/v1/admin/model-policy.json',
    auth: 'admin',
    handler: async (request, ctx) => {
      if (!isAdminEmail(ctx.email, ctx.env)) return json({ ok: false, error: 'Access required' }, 401)
      if (!isOwnerEmail(ctx.email, ctx.env)) {
        await auditLog(ctx, 'model-policy.denied', null, safeAuditText(`${ctx.email} is not an owner`))
        return json({ ok: false, error: 'Only the owner may change the fleet model policy.', code: 'not-owner' }, 403)
      }
      const body = (await request.json().catch(() => null)) as { capabilities?: unknown } | null
      if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid json' }, 400)
      const before = await readModelPolicy(ctx.env.DB)
      const result = await writeModelPolicy(ctx.env.DB, body.capabilities, ctx.email, ctx.now)
      if (!result.ok) {
        const status = result.error === 'db unbound' ? 503 : 400
        return json({ ok: false, error: result.error }, status)
      }
      await auditLog(
        ctx,
        'model-policy.update',
        null,
        safeAuditText(
          `before ${JSON.stringify(before?.capabilities ?? null)} after ${JSON.stringify(result.policy.capabilities)}`,
          500
        )
      )
      return json({ ok: true, policy: result.policy })
    }
  })
}

export interface ModelPolicyFetchEnv {
  DB?: import('../d1').D1DatabaseLike
  OPERATOR_INGEST_SECRET: string
}

/** `GET /v1/model-policy`, device-authenticated (dispatched from `index.ts` alongside `/v1/heartbeat`
 *  and `/v1/integrations`). `null` policy = "not managed", never an error — a fleet that has not yet
 *  configured a policy must keep working with today's defaults. */
export async function handleModelPolicyFetch(
  store: OperatorStore,
  env: ModelPolicyFetchEnv,
  request: Request,
  now: number
): Promise<Response> {
  void store
  const policy = await readModelPolicy(env.DB)
  if (!policy) return json({ ok: true, policy: null })
  // The secret this exact request just proved it holds via verifyDeviceRequest: a licensed seat's own
  // token when present, else the fleet-wide ingest secret. Signing with that secret means the seat can
  // verify offline with the same credential it already has, no separate distribution needed.
  const licenseToken = request.headers.get(OPERATOR_LICENSE_HEADER)?.trim()
  const secret = licenseToken || env.OPERATOR_INGEST_SECRET
  if (!secret) return json({ ok: false, error: 'model policy signing is not configured' }, 503)
  const parsed = ModelPolicyDocumentSchema.safeParse(policy)
  if (!parsed.success) return json({ ok: true, policy: null })
  const signature = await signModelPolicy(secret, parsed.data)
  return json({ ok: true, policy: parsed.data, signature })
}
