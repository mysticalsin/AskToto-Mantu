/**
 * `POST /v1/admin/licenses/generate-batch` (plan 6.7b): HTTP wiring only, all the logic lives in
 * `../licenses/batch.ts`'s `generateLicenseBatch`. Same admin auth, CSRF and admin-mutation rate
 * limit as every other `/v1/admin/*` mutation (`index.ts`, not owned by this task) - nothing extra
 * to wire here.
 */
import { json } from '../http'
import { generateLicenseBatch } from '../licenses/batch'
import { defineRoute } from './registry'
import type { AdminCtx } from './admin-ctx'

export function registerLicensesBatchRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/licenses/generate-batch',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const result = await generateLicenseBatch(ctx, {
        count: body.count,
        members: body.members,
        days: body.days,
        tier: body.tier,
        groupId: body.groupId
      })
      if (!result.ok) {
        return json(
          {
            ok: false,
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
            ...(result.invalid ? { invalid: result.invalid } : {}),
            ...(result.minted ? { minted: result.minted } : {})
          },
          result.status
        )
      }
      return json({ ok: true, batchId: result.batchId, count: result.count, licenses: result.licenses })
    }
  })
}
