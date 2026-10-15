import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SECTION_25_COVERAGE_ROWS,
  buildTraceabilityArtifacts,
  buildTraceabilityReport,
  checkTraceabilityReport,
  writeTraceabilityArtifacts
} from './build-traceability.mjs'
import { m2_0016Problems } from './m2-0016-lock.mjs'

const REPO = join(__dirname, '..', '..')
const scratchRoots: string[] = []

function normalizeCrLfToLf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

function asCrLf(lfBytes: Buffer): Buffer {
  const text = lfBytes.toString('utf8')
  if (text.includes('\r')) throw new Error('LF source fixture contains an unexpected carriage return')
  return Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8')
}

function isAcceptedCheckoutRepresentation(raw: Buffer, canonicalLf: Buffer): boolean {
  return raw.equals(canonicalLf) || raw.equals(asCrLf(canonicalLf))
}

function sameLineEdit(text: string): string {
  const index = text.search(/[^\r\n]/)
  if (index < 0) throw new Error('source reference has no editable character')
  return text.slice(0, index) + (text[index] === 'X' ? 'Y' : 'X') + text.slice(index + 1)
}

function copyScopedSourceTree(): {
  sourceRoot: string
  actual: ReturnType<typeof buildTraceabilityReport>
  references: string[]
} {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'metis-trace-source-root-'))
  scratchRoots.push(sourceRoot)
  const actual = buildTraceabilityReport()
  expect(actual.check.problems).toEqual([])
  expect(checkTraceabilityReport(actual)).toEqual([])
  for (const scope of actual.reviewed_scopes) {
    const source = join(REPO, ...scope.path.split('/'))
    const destination = join(sourceRoot, ...scope.path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  const references = actual.source_reference_observations.map((observation) => observation.reference_path)
  expect(references).toHaveLength(4)
  expect(new Set(references).size).toBe(4)
  for (const reference of references) {
    expect(
      actual.reviewed_scopes.filter((scope) => scope.path === reference && scope.exists && scope.readable)
    ).toHaveLength(1)
  }
  return { sourceRoot, actual, references }
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('traceability builder M2-0016 coverage rows', () => {
  it('builds the workflow artifact from Section 25 COV rows in traceability.json', () => {
    const { report, m2_0016Artifacts } = buildTraceabilityArtifacts({
      generatedAt: '2026-09-28T00:00:00Z'
    })
    const coverageRows = report.rows.filter((row) => row.family === 'COV' && row.section === 25)

    expect(coverageRows).toHaveLength(SECTION_25_COVERAGE_ROWS.length)
    expect(coverageRows.at(-1)).toMatchObject({
      id: 'COV-44',
      title: 'End-to-end deployed quality, recovery and durable handoff',
      tickets: ['M2-0183'],
      status: 'NOT_STARTED'
    })
    expect(report.check.problems).toEqual([])
    expect(m2_0016Problems(m2_0016Artifacts)).toEqual([])
    expect(m2_0016Artifacts.coverageMap).toContain(
      '| COV-44 | End-to-end deployed quality, recovery and durable handoff | M2-0183 | NOT_STARTED |'
    )
    expect(m2_0016Artifacts.evidence.coverage).toMatchObject({
      section: 25,
      rows: SECTION_25_COVERAGE_ROWS.length,
      all_rows_have_ticket: true
    })
  })

  it('fails the builder path when Section 25 COV rows are absent', () => {
    const { report, m2_0016Artifacts } = buildTraceabilityArtifacts({
      generatedAt: '2026-09-28T00:00:00Z',
      includeSection25Rows: false
    })

    expect(report.check.problems).toContain('traceability rows: missing Section 25 COV rows')
    expect(m2_0016Problems(m2_0016Artifacts)).toContain(
      'M2-0016 artifact missing Section 25 COV rows from traceability.json'
    )
    expect(m2_0016Artifacts.coverageMap).not.toContain('COV-44')
  })

  it('keeps the workflow on the same traceability builder command', () => {
    const workflow = readFileSync('.github/workflows/m2-0016-prd-lock.yml', 'utf8')
    const report = buildTraceabilityReport({ generatedAt: '2026-09-28T00:00:00Z' })

    expect(workflow).toContain('node scripts/trace/build-traceability.mjs --check --out out/m2-0016-prd-lock')
    expect(report.rows.some((row) => row.family === 'COV' && row.section === 25)).toBe(true)
  })

  it('rejects a same-line source edit against the fixed content reference', () => {
    const { sourceRoot, actual, references } = copyScopedSourceTree()
    for (const rel of references) {
      const file = join(sourceRoot, ...rel.split('/'))
      const originalBytes = readFileSync(file)
      const canonicalBytes = normalizeCrLfToLf(originalBytes)
      const canonicalText = canonicalBytes.toString('utf8')
      expect(isAcceptedCheckoutRepresentation(originalBytes, canonicalBytes)).toBe(true)
      const editedText = sameLineEdit(canonicalText)
      expect(editedText).not.toBe(canonicalText)
      expect(editedText.split('\n')).toHaveLength(canonicalText.split('\n').length)
      try {
        writeFileSync(file, editedText)
        const report = buildTraceabilityReport({ sourceRoot })
        expect(report.reviewed_scopes.find((scope) => scope.path === rel)?.lines).toBe(
          actual.reviewed_scopes.find((scope) => scope.path === rel)?.lines
        )
        expect(report.check.problems).toContain(`${rel}: source reference digest mismatch`)
      } finally {
        writeFileSync(file, originalBytes)
      }
    }
  })

  it('rejects a missing extracted publish-provenance source', () => {
    const { sourceRoot, actual, references } = copyScopedSourceTree()
    const historical = new Set(actual.historical_source_references.map((reference) => reference.reference_path))
    expect(historical.size).toBe(3)
    const extracted = references.filter((reference) => !historical.has(reference))
    expect(extracted).toHaveLength(1)
    const [rel] = extracted
    rmSync(join(sourceRoot, ...rel.split('/')))

    const report = buildTraceabilityReport({ sourceRoot })
    expect(report.check.problems).toContain(`${rel}: missing scoped file`)
    expect(report.check.problems).toContain(`${rel}: required source reference file is missing or unreadable`)
  })

  it('matches LF and CRLF source references while retaining distinct raw byte hashes', () => {
    const { sourceRoot, references } = copyScopedSourceTree()
    for (const rel of references) {
      const file = join(sourceRoot, ...rel.split('/'))
      const originalBytes = readFileSync(file)
      const canonicalLf = normalizeCrLfToLf(originalBytes)
      expect(isAcceptedCheckoutRepresentation(originalBytes, canonicalLf)).toBe(true)
      const canonicalText = canonicalLf.toString('utf8')
      expect(canonicalText.includes('\r')).toBe(false)
      try {
        writeFileSync(file, canonicalLf)
        const lfReport = buildTraceabilityReport({ sourceRoot })
        expect(lfReport.check.problems).toEqual([])
        writeFileSync(file, asCrLf(canonicalLf))
        const crlfReport = buildTraceabilityReport({ sourceRoot })
        expect(crlfReport.check.problems).toEqual([])
        const observation = crlfReport.source_reference_observations.find(
          (reference) => reference.reference_path === rel
        )
        if (!observation) throw new Error(`missing source reference observation for ${rel}`)
        const lfObservation = lfReport.source_reference_observations.find(
          (reference) => reference.reference_path === rel
        )
        expect(lfObservation?.observed_canonical_sha256).toBe(observation.expected_sha256)
        expect(observation).toMatchObject({
          classification: 'SOURCE_REFERENCE_ONLY',
          hash_policy: 'sha256-utf8-crlf-to-lf',
          matches_expected: true
        })
        expect(observation.observed_canonical_sha256).toBe(observation.expected_sha256)
        expect(observation.observed_raw_sha256).not.toBe(observation.observed_canonical_sha256)
        expect(observation.observed_raw_sha256).not.toBe(lfObservation?.observed_raw_sha256)

        const mutatedLfText = sameLineEdit(canonicalText)
        expect(mutatedLfText).not.toBe(canonicalText)
        expect(mutatedLfText.split('\n')).toHaveLength(canonicalText.split('\n').length)
        writeFileSync(file, asCrLf(Buffer.from(mutatedLfText, 'utf8')))
        const editedCrlfReport = buildTraceabilityReport({ sourceRoot })
        expect(editedCrlfReport.check.problems).toContain(`${rel}: source reference digest mismatch`)
      } finally {
        writeFileSync(file, originalBytes)
      }
    }
  })

  it('rejects missing malformed or duplicate required reference metadata', () => {
    const { actual, references } = copyScopedSourceTree()
    for (const rel of references) {
      const missing = structuredClone(actual)
      missing.source_reference_observations = missing.source_reference_observations.filter(
        (reference) => reference.reference_path !== rel
      )
      expect(checkTraceabilityReport(missing)).toContain(
        `${rel}: expected exactly one source reference observation, found 0`
      )

      const malformed = structuredClone(actual)
      const observation = malformed.source_reference_observations.find((reference) => reference.reference_path === rel)
      if (!observation) throw new Error(`missing source reference observation for ${rel}`)
      observation.hash_policy = 'sha256-anything-goes'
      expect(checkTraceabilityReport(malformed)).toContain(
        `${rel}: source reference hash_policy does not match fixed builder metadata`
      )

      const duplicate = structuredClone(actual)
      const duplicateObservation = duplicate.source_reference_observations.find(
        (reference) => reference.reference_path === rel
      )
      if (!duplicateObservation) throw new Error(`missing source reference observation for ${rel}`)
      duplicate.source_reference_observations.push(structuredClone(duplicateObservation))
      expect(checkTraceabilityReport(duplicate)).toContain(
        `${rel}: expected exactly one source reference observation, found 2`
      )
    }
  })

  it('writes the validated source-bound report and derived Section 25 artifacts', () => {
    const { sourceRoot } = copyScopedSourceTree()
    const report = buildTraceabilityReport({ sourceRoot, generatedAt: '2026-09-28T00:00:00Z' })
    const outDir = 'out/actual-source-bound-traceability'
    const artifacts = writeTraceabilityArtifacts(sourceRoot, outDir, report)
    const output = join(sourceRoot, outDir)
    const expectedFiles = [
      'COVERAGE-MAP.md',
      'README.md',
      'THREAT-MODEL.md',
      'm2-0016-evidence.json',
      'prd-lock.md',
      'traceability.json'
    ]

    expect(readdirSync(output).sort()).toEqual(expectedFiles)
    expect(JSON.parse(readFileSync(join(output, 'traceability.json'), 'utf8'))).toEqual(report)
    expect(m2_0016Problems(artifacts)).toEqual([])
    expect(artifacts.evidence.coverage).toMatchObject({ section: 25, rows: 44, all_rows_have_ticket: true })
    expect(readFileSync(join(output, 'COVERAGE-MAP.md'), 'utf8')).toContain(
      '| COV-44 | End-to-end deployed quality, recovery and durable handoff | M2-0183 | NOT_STARTED |'
    )
    const readme = readFileSync(join(output, 'README.md'), 'utf8')
    expect(readme).toContain('SOURCE_REFERENCE_ONLY')
    expect(readme).toContain('runtime and installed-app qualification remain separate')
    expect(readme).toContain('eae96341c3771748b0bcfaf12de48cdb6e114d40')
  })
})
