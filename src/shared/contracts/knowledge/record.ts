import { z } from 'zod'
import {
  ActorSchema,
  InstantSchema,
  PrincipalRefSchema,
  RecordAddressSchema,
  RecordKeySchema,
  RevisionSchema,
  SourceRefSchema,
  type PrincipalRef,
  type RecordAddress
} from './identity'
import { reportIssue } from './issue'
import { FieldNameSchema, FieldSchema, type Claim, type Field } from './provenance'

/**
 * Canonical knowledge records and their tombstones (ADR-019, M2-0120). The knowledge service is the
 * only writer; every other surface reads them or proposes a mutation. Records and tombstones drop keys
 * they do not know, so an older client keeps reading a record that a newer service extends with new keys.
 * Only new keys are compatible: a new enum value, or a new key inside a strict address, key or principal,
 * fails an older parser and is therefore a breaking contract change.
 */

/**
 * The record kinds the canonical model keeps apart, plus `deal` from the existing brain. A meeting
 * occurrence is not its series, and a proposed correction is not the record it would change.
 */
export const RecordTypeSchema = z.enum([
  'meeting-occurrence',
  'meeting-summary',
  'decision',
  'action',
  'account',
  'person',
  'deal',
  'skill-output',
  'correction-proposal'
])
export type RecordType = z.infer<typeof RecordTypeSchema>

const principalKey = (principal: PrincipalRef): string => `${principal.kind}:${principal.id}`
const listsAnyPrincipalTwice = (principals: PrincipalRef[]): boolean =>
  new Set(principals.map(principalKey)).size !== principals.length
const sameAddress = (a: RecordAddress, b: RecordAddress): boolean => a.space === b.space && a.id === b.id

/**
 * The record's source ACL. `epoch` increases on every access change and only then, so projections and
 * caches fence on (revision, epoch): a revocation invalidates them without any content change.
 */
export const AccessSchema = z
  .object({
    epoch: z.number().int().nonnegative(),
    readers: z.array(PrincipalRefSchema).min(1).max(256),
    editors: z.array(PrincipalRefSchema).max(256)
  })
  .superRefine((access, context) => {
    if (listsAnyPrincipalTwice(access.readers)) reportIssue(context, 'Each reader is listed once.', ['readers'])
    if (listsAnyPrincipalTwice(access.editors)) reportIssue(context, 'Each editor is listed once.', ['editors'])
    const readers = new Set(access.readers.map(principalKey))
    access.editors.forEach((editor, index) => {
      if (!readers.has(principalKey(editor))) reportIssue(context, 'An editor is also a reader.', ['editors', index])
    })
  })
export type Access = z.infer<typeof AccessSchema>

function claimsWithPaths(field: Field): Array<{ claim: Claim; path: Array<string | number> }> {
  return [
    { claim: field.current, path: ['current'] },
    ...field.history.map((claim, index) => ({ claim, path: ['history', index] })),
    ...field.disputes.map((claim, index) => ({ claim, path: ['disputes', index] }))
  ]
}

export const KnowledgeRecordSchema = z
  .object({
    key: RecordKeySchema,
    type: RecordTypeSchema,
    revision: RevisionSchema,
    /** The principal accountable for the source of this record. It grants no access; only `access` does. */
    owner: PrincipalRefSchema,
    committedBy: ActorSchema,
    committedAt: InstantSchema,
    /** The source item this record was derived from, when it has exactly one. */
    source: SourceRefSchema.optional(),
    access: AccessSchema,
    sensitivity: z.enum(['internal', 'confidential']),
    retention: z.object({ policy: z.string().min(1).max(64), expiresAt: InstantSchema.optional() }),
    dates: z.object({ observed: InstantSchema, event: InstantSchema.optional(), effective: InstantSchema.optional() }),
    fields: z.record(FieldNameSchema, FieldSchema)
  })
  .superRefine((record, context) => {
    for (const [name, field] of Object.entries(record.fields)) {
      for (const { claim, path } of claimsWithPaths(field)) {
        const claimPath = ['fields', name, ...path]
        if (claim.attestation && claim.attestation.revision > record.revision) {
          const revisionPath = [...claimPath, 'attestation', 'revision']
          reportIssue(context, 'An attestation cannot name a later revision.', revisionPath)
        }
        claim.evidence.forEach((evidence, index) => {
          if (evidence.kind === 'record' && sameAddress(evidence.record, record.key)) {
            reportIssue(context, 'A claim never cites its own record.', [...claimPath, 'evidence', index])
          }
        })
      }
    }
  })
export type KnowledgeRecord = z.infer<typeof KnowledgeRecordSchema>

/**
 * What remains of a deleted or merged record. Tombstones are permanent and record ids are never reused:
 * every read of the key is blocked, every write is refused, and a re-ingest of the same `source` item
 * cannot bring the record back from a stale device or a restored backup.
 */
export const TombstoneSchema = z
  .object({
    key: RecordKeySchema,
    type: RecordTypeSchema,
    /** The revision the deletion committed as. */
    revision: RevisionSchema,
    deletedAt: InstantSchema,
    deletedBy: ActorSchema,
    reason: z.enum(['user-request', 'retention-expired', 'source-deleted', 'merged']),
    source: SourceRefSchema.optional(),
    /** The record a merged record now lives in. */
    successor: RecordAddressSchema.optional()
  })
  .superRefine((tombstone, context) => {
    if ((tombstone.reason === 'merged') !== (tombstone.successor !== undefined)) {
      reportIssue(context, 'A merged record names its successor, and only a merged one does.', ['successor'])
    } else if (tombstone.successor && sameAddress(tombstone.successor, tombstone.key)) {
      reportIssue(context, 'A record is not its own successor.', ['successor'])
    }
  })
export type Tombstone = z.infer<typeof TombstoneSchema>
