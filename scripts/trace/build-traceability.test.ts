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

function copyScopedSourceTree(): string {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'metis-trace-source-root-'))
  scratchRoots.push(sourceRoot)
  const actual = buildTraceabilityReport()
  expect(actual.check.problems).toEqual([])
  for (const scope of actual.reviewed_scopes) {
    const source = join(REPO, ...scope.path.split('/'))
    const destination = join(sourceRoot, ...scope.path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  return sourceRoot
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
    const sourceRoot = copyScopedSourceTree()
    const rel = 'src/main/brain/publish.ts'
    const file = join(sourceRoot, ...rel.split('/'))
    const originalBytes = readFileSync(file)
    const canonicalBytes = normalizeCrLfToLf(originalBytes)
    const canonicalText = canonicalBytes.toString('utf8')
    expect(isAcceptedCheckoutRepresentation(originalBytes, canonicalBytes)).toBe(true)
    expect(canonicalText.startsWith('import {\n')).toBe(true)
    writeFileSync(file, canonicalText.replace(/^import \{/m, 'import  {'))

    const report = buildTraceabilityReport({ sourceRoot })
    expect(report.reviewed_scopes.find((scope) => scope.path === rel)?.lines).toBe(
      buildTraceabilityReport().reviewed_scopes.find((scope) => scope.path === rel)?.lines
    )
    expect(report.check.problems).toContain(`${rel}: source reference digest mismatch`)
  })

  it('rejects a missing extracted publish-provenance source', () => {
    const sourceRoot = copyScopedSourceTree()
    const rel = 'src/main/brain/publish-provenance.ts'
    rmSync(join(sourceRoot, ...rel.split('/')))

    const report = buildTraceabilityReport({ sourceRoot })
    expect(report.check.problems).toContain(`${rel}: missing scoped file`)
    expect(report.check.problems).toContain(`${rel}: required source reference file is missing or unreadable`)
  })

  it('matches LF and CRLF source references while retaining distinct raw byte hashes', () => {
    const sourceRoot = copyScopedSourceTree()
    const rel = 'src/main/brain/publish.ts'
    const file = join(sourceRoot, ...rel.split('/'))
    const originalBytes = readFileSync(file)
    const canonicalLf = normalizeCrLfToLf(originalBytes)
    expect(isAcceptedCheckoutRepresentation(originalBytes, canonicalLf)).toBe(true)
    const canonicalText = canonicalLf.toString('utf8')
    expect(canonicalText.includes('\r')).toBe(false)
    writeFileSync(file, asCrLf(canonicalLf))

    const crlfReport = buildTraceabilityReport({ sourceRoot })
    expect(crlfReport.check.problems).toEqual([])
    const observation = crlfReport.source_reference_observations.find((reference) => reference.reference_path === rel)
    if (!observation) throw new Error(`missing source reference observation for ${rel}`)
    expect(observation).toMatchObject({
      classification: 'SOURCE_REFERENCE_ONLY',
      hash_policy: 'sha256-utf8-crlf-to-lf',
      matches_expected: true
    })
    expect(observation.observed_canonical_sha256).toBe(observation.expected_sha256)
    expect(observation.observed_raw_sha256).not.toBe(observation.observed_canonical_sha256)

    const mutatedLfText = canonicalText.replace('import {\n', 'import  {\n')
    expect(mutatedLfText).not.toBe(canonicalText)
    expect(mutatedLfText.split('\n').length).toBe(canonicalText.split('\n').length)
    writeFileSync(file, asCrLf(Buffer.from(mutatedLfText, 'utf8')))
    const editedCrlfReport = buildTraceabilityReport({ sourceRoot })
    expect(editedCrlfReport.check.problems).toContain(`${rel}: source reference digest mismatch`)
  })

  it('rejects missing malformed or duplicate required reference metadata', () => {
    const report = buildTraceabilityReport()

    const missing = structuredClone(report)
    missing.source_reference_observations = missing.source_reference_observations.filter(
      (reference) => reference.reference_path !== 'src/main/brain/publish.ts'
    )
    expect(checkTraceabilityReport(missing)).toContain(
      'src/main/brain/publish.ts: expected exactly one source reference observation, found 0'
    )

    const malformed = structuredClone(report)
    const publishObservation = malformed.source_reference_observations.find(
      (reference) => reference.reference_path === 'src/main/brain/publish.ts'
    )
    if (!publishObservation) throw new Error('missing publish source reference observation')
    publishObservation.hash_policy = 'sha256-anything-goes'
    expect(checkTraceabilityReport(malformed)).toContain(
      'src/main/brain/publish.ts: source reference hash_policy does not match fixed builder metadata'
    )

    const duplicate = structuredClone(report)
    duplicate.source_reference_observations.push(structuredClone(duplicate.source_reference_observations[0]))
    expect(checkTraceabilityReport(duplicate)).toContain(
      `${duplicate.source_reference_observations[0].reference_path}: expected exactly one source reference observation, found 2`
    )
  })

  it('writes the validated source-bound report and derived Section 25 artifacts', () => {
    const sourceRoot = copyScopedSourceTree()
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
