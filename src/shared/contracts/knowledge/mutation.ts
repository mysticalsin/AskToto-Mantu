import { z } from 'zod'
import { RecordAddressSchema, RevisionSchema } from './identity'
import { reportIssue } from './issue'
import { EvidenceRefSchema, FieldNameSchema, JsonValueSchema } from './provenance'
import { RecordTypeSchema } from './record'

/**
 * Writes to canonical knowledge (ADR-019, M2-0120). A mutation carries no actor, tenant or claim
 * state: the service takes the actor and tenant from the validated token and derives each resulting state
 * from the operation and that actor. Requests are strict, so an injected key is refused, not ignored;
 * outcomes, like records, drop keys an older client does not know.
 */

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const RevisionOrAbsentSchema = z.number().int().nonnegative()

/**
 * One operation of a typed patch and the state it produces:
 * - `set`: EDITED, or PINNED when `pin` is true.
 * - `verify`: HUMAN-VERIFIED, confirming the value the caller read at `expectedRevision`.
 * - `pin`: PINNED, locking the value the caller read. A PINNED value then changes only through an
 *   approved correction proposal.
 * - `delete`: DELETED.
 */
export const FieldOperationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('set'),
      field: FieldNameSchema,
      value: JsonValueSchema.refine((value) => value !== null, 'Remove a value with the delete operation.'),
      pin: z.literal(true).optional()
    })
    .strict(),
  z.object({ op: z.literal('verify'), field: FieldNameSchema }).strict(),
  z.object({ op: z.literal('pin'), field: FieldNameSchema }).strict(),
  z.object({ op: z.literal('delete'), field: FieldNameSchema }).strict()
])
export type FieldOperation = z.infer<typeof FieldOperationSchema>

export const KnowledgeMutationSchema = z
  .object({
    target: RecordAddressSchema,
    /** The revision the caller read, or 0 to create a record that must not exist yet. */
    expectedRevision: RevisionOrAbsentSchema,
    /** The type of the record being created; present exactly when `expectedRevision` is 0. */
    type: RecordTypeSchema.optional(),
    /** Replaying a key replays its outcome; reusing it for a different body is rejected. */
    idempotencyKey: IdempotencyKeySchema,
    reason: z.string().min(1).max(500),
    evidence: z.array(EvidenceRefSchema).max(16),
    patch: z.array(FieldOperationSchema).min(1).max(64)
  })
  .strict()
  .superRefine((mutation, context) => {
    const creates = mutation.expectedRevision === 0
    if (creates !== (mutation.type !== undefined)) {
      reportIssue(context, 'A mutation names the record type exactly when it creates the record.', ['type'])
    }
    const touched = new Set<string>()
    mutation.patch.forEach((operation, index) => {
      if (touched.has(operation.field)) {
        reportIssue(context, 'A patch touches each field once.', ['patch', index, 'field'])
      }
      touched.add(operation.field)
      if (creates && operation.op !== 'set') {
        reportIssue(context, 'A new record only sets values.', ['patch', index, 'op'])
      }
    })
  })
export type KnowledgeMutation = z.infer<typeof KnowledgeMutationSchema>

const committedShape = { idempotencyKey: IdempotencyKeySchema, target: RecordAddressSchema, revision: RevisionSchema }

/**
 * Where a mutation stands. Acceptance is not completion: only COMMITTED and later name the revision a
 * read-back returns.
 * - RECEIVED, VALIDATED: accepted and checked, not yet written.
 * - PENDING-APPROVAL: filed as a correction proposal that a person must approve.
 * - COMMITTED: durable in the canonical store at `revision`.
 * - PROJECTION-PENDING: committed and read back, and the projections are refreshing.
 * - VISIBLE: every projection serves `revision` or later.
 * - CONFLICT: the record is at `currentRevision` (0 when absent), not the expected one; nothing was written.
 * - REJECTED: nothing was written. `forbidden`: the actor lacks the right (an agent never approves its own
 *   proposal). `invalid`: the patch breaks the record type's field rules. `deleted`: the target is a
 *   tombstone. `evidence-unavailable`: cited evidence does not resolve or the actor cannot read it.
 *   `idempotency-key-reused`: the key was already used for a different body.
 */
export const MutationOutcomeSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('RECEIVED'), idempotencyKey: IdempotencyKeySchema }),
    z.object({ status: z.literal('VALIDATED'), idempotencyKey: IdempotencyKeySchema }),
    z.object({
      status: z.literal('PENDING-APPROVAL'),
      idempotencyKey: IdempotencyKeySchema,
      proposal: RecordAddressSchema
    }),
    z.object({ status: z.literal('COMMITTED'), ...committedShape }),
    z.object({ status: z.literal('PROJECTION-PENDING'), ...committedShape }),
    z.object({ status: z.literal('VISIBLE'), ...committedShape }),
    z.object({
      status: z.literal('CONFLICT'),
      idempotencyKey: IdempotencyKeySchema,
      target: RecordAddressSchema,
      expectedRevision: RevisionOrAbsentSchema,
      currentRevision: RevisionOrAbsentSchema
    }),
    z.object({
      status: z.literal('REJECTED'),
      idempotencyKey: IdempotencyKeySchema,
      code: z.enum(['forbidden', 'invalid', 'deleted', 'evidence-unavailable', 'idempotency-key-reused'])
    })
  ])
  .superRefine((outcome, context) => {
    if (outcome.status === 'CONFLICT' && outcome.currentRevision === outcome.expectedRevision) {
      reportIssue(context, 'A conflict reports a revision other than the expected one.', ['currentRevision'])
    }
  })
export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>
