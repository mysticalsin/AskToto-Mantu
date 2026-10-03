import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OcrResultSchema } from './index'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

function fixtures(kind: 'golden' | 'negative'): Array<[string, unknown]> {
  return readdirSync(join(FIXTURES, kind))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => [file, JSON.parse(readFileSync(join(FIXTURES, kind, file), 'utf8'))])
}

function hydratedNegative(file: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (file === 'too-many-lines.json') {
    const base = value as { lines: unknown[] }
    return { ...base, lines: Array.from({ length: 201 }, (_, i) => ({
      id: `line-${i}`,
      text: `line ${i}`,
      confidence: null,
      box: { x: 0.01, y: Math.min(0.99, i * 0.001), width: 0.1, height: 0.001 }
    })) }
  }
  if (file === 'too-many-words.json') {
    const base = value as { words: unknown[] }
    return { ...base, words: Array.from({ length: 2001 }, (_, i) => ({
      text: `w${i}`,
      confidence: null,
      box: { x: 0.01, y: Math.min(0.99, i * 0.0001), width: 0.001, height: 0.001 },
      lineId: 'line-1'
    })) }
  }
  return value
}

const golden = fixtures('golden')
const negative = fixtures('negative')

const REJECTED_AT: Record<string, Array<string | number>> = {
  'box-out-of-range.json': ['lines', 0, 'box', 'width'],
  'coverage-not-visible-only.json': ['coverage'],
  'missing-untrusted-marker.json': ['untrustedContent'],
  'too-many-lines.json': ['lines'],
  'too-many-words.json': ['words'],
  'unknown-line-link.json': ['words', 0, 'lineId'],
  'words-out-of-order.json': ['words', 1]
}

describe('ocr contract: golden fixtures', () => {
  it.each(golden)('%s parses', (_file, value) => {
    const result = OcrResultSchema.safeParse(value)
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true)
  })
})

describe('ocr contract: negative fixtures', () => {
  it('pins every negative fixture to the invariant it breaks', () => {
    expect(negative.map(([file]) => file)).toEqual(Object.keys(REJECTED_AT).sort())
  })

  it.each(negative)('%s is rejected at its invariant', (file, value) => {
    const result = OcrResultSchema.safeParse(hydratedNegative(file, value))
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([REJECTED_AT[file]])
  })
})
