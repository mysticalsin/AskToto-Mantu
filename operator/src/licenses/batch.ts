/**
 * Batch license minting (plan 6.7b "Generate many licenses at once"): the logic behind `POST
 * /v1/admin/licenses/generate-batch` (HTTP wiring in `../routes/licenses-batch.ts`). Mints 1 to
 * 100 licenses in one call, either `count` unassigned licenses sharing one tier/group, or one
 * license per line in `members` (an email or a device id each), through `mintOperatorLicense` so
 * minting itself never has a second implementation. Every member line is validated the same way
 * the single per-group generate route validates one (`groups.ts`'s member auto-detect: an email
 * shape, or an existing seat's device id; kept as its own small copy here rather than an import
 * across the ownership boundary, the same choice `seat-timeline.ts` and `client/licenses.ts`
 * already make for a short, already-proven check that is not worth a cross-module dependency for)
 * and the whole batch is rejected, with every bad line named, before a single license is minted.
 *
 * `batch_id` is stamped by `mintOperatorLicense` itself (see its `batchId` input) once per row, so
 * this module only has to generate the id and pass it through.
 */
import { mintOperatorLicense } from './generate'
import { auditLog, type AdminCtx } from '../routes/admin-ctx'
import { DEFAULT_TIER_ENTITLEMENTS } from '../store'

export const BATCH_MAX = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function describeRaw(raw: unknown): string {
  if (raw === undefined) return 'undefined'
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

export interface BatchLineIssue {
  line: string
  error: string
}

export interface MintedBatchLicense {
  jti: string
  license: string
  last4: string
  member: string | null
  tier: string | null
  groupId: string | null
  days: number
  exp: number
}

export interface BatchGenerateInput {
  count?: unknown
  members?: unknown
  days: unknown
  tier?: unknown
  groupId?: unknown
}

export type BatchGenerateResult =
  | { ok: true; batchId: string; count: number; licenses: MintedBatchLicense[] }
  | {
      ok: false
      error: string
      status: number
      code?: string
      /** Only set for `code: 'invalid-members'`: every line that failed validation, so the caller
       *  can show all of them at once rather than one at a time. */
      invalid?: BatchLineIssue[]
      /** Only set for `code: 'partial-batch'`: licenses that minted before a later one failed.
       *  These are real, already-existing credentials - the once-strings must still reach Tony,
       *  never silently dropped because the batch as a whole did not fully succeed. */
      minted?: MintedBatchLicense[]
    }

/** Same auto-detect rule `groups.ts`'s per-license `member` field uses: trim, accept an email
 *  shape lowercased, else an existing seat's device id, else reject naming what was expected. */
async function validateBatchMemberLine(
  store: Pick<AdminCtx['store'], 'getSeat'>,
  line: string
): Promise<{ ok: true; member: string } | { ok: false; error: string }> {
  if (EMAIL_RE.test(line)) return { ok: true, member: line.toLowerCase() }
  const seat = await store.getSeat(line)
  if (seat) return { ok: true, member: line }
  return {
    ok: false,
    error: `not a valid email address or an existing seat device id, received ${describeRaw(line)}, for example "name@example.com" or a device id copied from the Sessions page`
  }
}

export async function generateLicenseBatch(ctx: AdminCtx, input: BatchGenerateInput): Promise<BatchGenerateResult> {
  const hasMembers = input.members !== undefined
  const hasCount = input.count !== undefined
  if (hasMembers === hasCount) {
    return {
      ok: false,
      error: 'provide exactly one of count (a number) or members (an array of email addresses or device ids), never both or neither',
      status: 400
    }
  }

  let memberLines: string[] | null = null
  if (hasMembers) {
    if (!Array.isArray(input.members)) {
      return { ok: false, error: `members must be an array of strings, received ${describeRaw(input.members)}`, status: 400 }
    }
    memberLines = input.members.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => m.length > 0)
    if (!memberLines.length) return { ok: false, error: 'members must contain at least one non-empty line', status: 400 }
  }

  const count = memberLines ? memberLines.length : Number(input.count)
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, error: `count must be a whole number of 1 or more, received ${describeRaw(input.count)}`, status: 400 }
  }
  if (count > BATCH_MAX) {
    return {
      ok: false,
      error: `a batch is capped at ${BATCH_MAX} licenses, received ${count}, split this into more than one batch`,
      status: 400,
      code: 'batch-too-large'
    }
  }

  let groupId = typeof input.groupId === 'string' ? input.groupId.trim() : ''
  let tier = typeof input.tier === 'string' ? input.tier.trim() : ''
  if (groupId) {
    const group = await ctx.store.getGroup(groupId)
    if (!group) return { ok: false, error: `groupId does not match an existing group, received ${describeRaw(input.groupId)}`, status: 400 }
    if (!tier) tier = group.tier
  }
  if (tier) {
    const tiers = await ctx.store.listTiers()
    const knownTiers = tiers.length ? tiers.map((t) => t.id) : Object.keys(DEFAULT_TIER_ENTITLEMENTS)
    if (!knownTiers.includes(tier)) {
      return {
        ok: false,
        error: `tier must be one of ${knownTiers.join(', ')}, received ${describeRaw(input.tier)}`,
        status: 400
      }
    }
  }

  if (memberLines) {
    const invalid: BatchLineIssue[] = []
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const line of memberLines) {
      const result = await validateBatchMemberLine(ctx.store, line)
      if (!result.ok) {
        invalid.push({ line, error: result.error })
        continue
      }
      const key = result.member.toLowerCase()
      if (seen.has(key)) {
        invalid.push({ line, error: `duplicate of an earlier line in this batch, received ${describeRaw(line)}` })
        continue
      }
      seen.add(key)
      normalized.push(result.member)
    }
    if (invalid.length) {
      return {
        ok: false,
        error: `${invalid.length} of ${memberLines.length} line${memberLines.length === 1 ? '' : 's'} could not be validated, nothing was minted`,
        status: 400,
        code: 'invalid-members',
        invalid
      }
    }
    memberLines = normalized
  }

  const batchId = crypto.randomUUID()
  const licenses: MintedBatchLicense[] = []
  for (let i = 0; i < count; i++) {
    const member = memberLines ? memberLines[i] : null
    const minted = await mintOperatorLicense(ctx, {
      days: input.days,
      groupId: groupId || null,
      tier: tier || null,
      member,
      actor: ctx.email,
      action: 'license-generate-batch-item',
      batchId
    })
    if (!minted.ok) {
      return {
        ok: false,
        error: `minted ${licenses.length} of ${count} before failing: ${minted.error}`,
        status: minted.status,
        code: 'partial-batch',
        minted: licenses
      }
    }
    licenses.push({
      jti: minted.jti,
      license: minted.token,
      last4: minted.last4,
      member: minted.member,
      tier: minted.tier,
      groupId: minted.groupId,
      days: minted.days,
      exp: minted.exp
    })
  }

  await auditLog(ctx, 'license-generate-batch', null, `${count} licenses, batch ${batchId}`)
  return { ok: true, batchId, count, licenses }
}
