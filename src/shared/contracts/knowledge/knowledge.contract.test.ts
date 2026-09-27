import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodTypeAny } from 'zod'
import {
  KnowledgeMutationSchema,
  KnowledgeRecordSchema,
  MutationOutcomeSchema,
  ProvenanceStateSchema,
  TombstoneSchema,
  type KnowledgeRecord
} from './index'

/**
 * Golden and negative fixtures of the canonical knowledge contract (ADR-019, M2-0120), each named
 * `<schema>.<case>.json`. Every golden parses. Every negative is rejected with exactly one issue, at the path
 * of the invariant it breaks, so a negative that fails for an unrelated reason fails this suite.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

const SCHEMAS: Record<string, ZodTypeAny> = {
  record: KnowledgeRecordSchema,
  tombstone: TombstoneSchema,
  mutation: KnowledgeMutationSchema,
  outcome: MutationOutcomeSchema
}

const SECTOR = ['fields', 'sector', 'current']

/** Each negative fixture, and the path of the one issue it must be rejected with. */
const REJECTED_AT: Record<string, Array<string | number>> = {
  'mutation.actor-injected.json': [],
  'mutation.create-with-verify.json': ['patch', 0, 'op'],
  'mutation.create-without-type.json': ['type'],
  'mutation.field-is-path.json': ['patch', 0, 'field'],
  'mutation.field-twice.json': ['patch', 1, 'field'],
  'mutation.op-sets-state.json': ['patch', 0],
  'mutation.set-null.json': ['patch', 0, 'value'],
  'mutation.tenant-in-target.json': ['target'],
  'outcome.committed-without-revision.json': ['revision'],
  'outcome.conflict-same-revision.json': ['currentRevision'],
  'record.attestation-from-later-revision.json': [...SECTOR, 'attestation', 'revision'],
  'record.confidence-on-pinned.json': [...SECTOR, 'confidence'],
  'record.deleted-keeps-quote.json': [...SECTOR, 'evidence', 0, 'quote'],
  'record.deleted-with-value.json': [...SECTOR, 'value'],
  'record.disputed-without-dispute.json': ['fields', 'sector', 'disputes'],
  'record.editor-not-reader.json': ['access', 'editors', 0],
  'record.evidence-cites-own-record.json': [...SECTOR, 'evidence', 0],
  'record.evidence-cites-wiki.json': [...SECTOR, 'evidence', 0, 'source', 'system'],
  'record.extracted-without-quote.json': [...SECTOR, 'evidence'],
  'record.field-name-is-path.json': ['fields', 'access.readers'],
  'record.history-not-superseded.json': ['fields', 'sector', 'history', 0, 'state'],
  'record.human-verified-without-attestation.json': [...SECTOR, 'attestation'],
  'record.inferred-with-attestation.json': [...SECTOR, 'attestation'],
  'record.pinned-by-service.json': [...SECTOR, 'attestation', 'by', 'kind'],
  'record.reader-anyone.json': ['access', 'readers', 0, 'kind'],
  'record.source-observed-without-source.json': [...SECTOR, 'evidence'],
  'record.superseded-as-current.json': [...SECTOR, 'state'],
  'record.user-on-behalf-of.json': ['committedBy', 'onBehalfOf'],
  'tombstone.merged-without-successor.json': ['successor'],
  'tombstone.own-successor.json': ['successor']
}

type Fixture = { file: string; schema: ZodTypeAny; value: unknown }

function loadFixtures(kind: 'golden' | 'negative'): Fixture[] {
  const directory = join(FIXTURES, kind)
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const schema = SCHEMAS[file.split('.')[0]]
      if (!schema) throw new Error(`${kind}/${file} does not start with the name of a contract schema`)
      return { file, schema, value: JSON.parse(readFileSync(join(directory, file), 'utf8')) }
    })
}

function claimStates(record: KnowledgeRecord): string[] {
  return Object.values(record.fields)
    .flatMap((field) => [field.current, ...field.history, ...field.disputes])
    .map((claim) => claim.state)
}

const golden = loadFixtures('golden')
const negative = loadFixtures('negative')

describe('knowledge contract: golden fixtures', () => {
  it.each(golden.map((fixture) => [fixture.file, fixture] as const))('%s parses', (_file, fixture) => {
    const result = fixture.schema.safeParse(fixture.value)
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
  })

  it('hold every one of the ten provenance states', () => {
    const records = golden.filter((fixture) => fixture.file.startsWith('record.'))
    const states = new Set(records.flatMap((fixture) => claimStates(KnowledgeRecordSchema.parse(fixture.value))))
    expect([...states].sort()).toEqual([...ProvenanceStateSchema.options].sort())
  })

  it('hold every mutation outcome status', () => {
    const outcomes = golden.filter((fixture) => fixture.file.startsWith('outcome.'))
    const statuses = outcomes.map((fixture) => MutationOutcomeSchema.parse(fixture.value).status)
    expect(statuses.sort()).toEqual([
      'COMMITTED',
      'CONFLICT',
      'PENDING-APPROVAL',
      'PROJECTION-PENDING',
      'RECEIVED',
      'REJECTED',
      'VALIDATED',
      'VISIBLE'
    ])
  })

  it('let a client read a record that carries keys from a newer service', () => {
    const fixture = golden.find((candidate) => candidate.file === 'record.from-newer-service.json')
    const parsed = KnowledgeRecordSchema.parse(fixture?.value)
    expect(parsed).not.toHaveProperty('labels')
    expect(parsed.fields.title.current).not.toHaveProperty('translation')
  })
})

describe('knowledge contract: negative fixtures', () => {
  it('each name the path they are rejected at', () => {
    expect(negative.map((fixture) => fixture.file)).toEqual(Object.keys(REJECTED_AT).sort())
  })

  it.each(negative.map((fixture) => [fixture.file, fixture] as const))(
    '%s is rejected at its invariant',
    (file, fixture) => {
      const result = fixture.schema.safeParse(fixture.value)
      expect(result.success).toBe(false)
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([REJECTED_AT[file]])
    }
  )
})
