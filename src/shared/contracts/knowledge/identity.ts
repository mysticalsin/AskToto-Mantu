import { z } from 'zod'
import { reportIssue } from './issue'

/**
 * Identity primitives of the canonical knowledge contract (ADR-019, M2-0120).
 *
 * Tenants, spaces, records and principals are GUIDs: Entra object ids for tenants, users, groups and
 * service principals, and service-assigned ids for spaces and records. A record id is never a filename or
 * a display-name slug, so a rename or a move cannot change what a citation points at.
 *
 * The identity tuples are strict: an unexpected key inside one is either an injection attempt or a
 * contract drift, and both must fail loudly.
 */

const GuidSchema = z.string().uuid()

/** A UTC ISO-8601 instant with a `Z` suffix. */
export const InstantSchema = z.string().datetime()

/** A committed record revision. Revision 0 means "the record does not exist" and is never stored. */
export const RevisionSchema = z.number().int().positive()

/** Addresses a record inside the tenant of the caller's validated token; a request never names a tenant. */
export const RecordAddressSchema = z.object({ space: GuidSchema, id: GuidSchema }).strict()
export type RecordAddress = z.infer<typeof RecordAddressSchema>

/** The stored, fully qualified identity of a record. */
export const RecordKeySchema = RecordAddressSchema.extend({ tenant: GuidSchema })
export type RecordKey = z.infer<typeof RecordKeySchema>

/**
 * An access-control subject. Only explicit Entra principals exist: there is deliberately no "anyone with
 * the link", "everyone in the tenant" or "meeting attendees" kind.
 */
export const PrincipalRefSchema = z.object({ kind: z.enum(['user', 'group', 'service']), id: GuidSchema }).strict()
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>

/**
 * Who committed a revision, taken from the validated token and never from a request body. A person acts
 * as themselves. An agent (for example a Dust agent) or a service acts under its own service principal,
 * optionally on behalf of a user, and a group never acts.
 */
export const ActorSchema = z
  .object({
    type: z.enum(['user', 'agent', 'service']),
    principal: PrincipalRefSchema,
    onBehalfOf: PrincipalRefSchema.optional()
  })
  .superRefine((actor, context) => {
    const expectedKind = actor.type === 'user' ? 'user' : 'service'
    if (actor.principal.kind !== expectedKind) {
      reportIssue(context, `A ${actor.type} actor is a ${expectedKind} principal.`, ['principal', 'kind'])
    }
    if (actor.onBehalfOf && (actor.type === 'user' || actor.onBehalfOf.kind !== 'user')) {
      reportIssue(context, 'Only an agent or a service acts on behalf of someone, and only of a user.', ['onBehalfOf'])
    }
  })
export type Actor = z.infer<typeof ActorSchema>

/**
 * An item in a system that holds source evidence, at the exact revision that was read. The allowlist is
 * the laundering guard: wiki pages, graphs, search indexes, memory and model answers are projections, so
 * they have no system here and can never be cited as evidence.
 */
export const SourceRefSchema = z.object({
  system: z.enum(['metis-meeting', 'microsoft-365']),
  id: z.string().min(1).max(512),
  revision: z.string().min(1).max(256)
})
export type SourceRef = z.infer<typeof SourceRefSchema>
