import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ATTRIBUTABLE_PROCESS_KINDS, classifyProcess } from '../census/lib.mjs'
import { RULES, RULE_IDS, canonicalJson, rulesSha256 } from './growth-rule.mjs'

/**
 * The registered pin of IDLE-GROWTH-1 and MEETING-GROWTH-1 (M2-0488). Any change to RULES fails here until a
 * reviewed PR updates this pin and states why; the new sha256 must then be registered again before a verdict
 * made under it counts as evidence.
 */
const RULES_SHA256_PIN = '53d05c480c66dbc8fe7005a235d67853fc7051acd13556d85c53bfb2e0a9b636'

/** Independent of growth-rule.mjs: JSON with object keys sorted at every depth. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function everyObjectFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true
  return Object.isFrozen(value) && Object.values(value).every(everyObjectFrozen)
}

describe('growth rules are pre-registered and pinned', () => {
  it('matches the pinned sha256 of the serialized RULES', () => {
    const digest = createHash('sha256').update(canonical(RULES), 'utf8').digest('hex')
    expect(digest).toBe(RULES_SHA256_PIN)
    expect(canonicalJson(RULES)).toBe(canonical(RULES))
    expect(rulesSha256()).toBe(RULES_SHA256_PIN)
  })

  it('is deeply frozen', () => {
    expect(everyObjectFrozen(RULES)).toBe(true)
    expect(() => {
      ;(RULES.IDLE_GROWTH_1 as { settleMinutes: number }).settleMinutes = 1
    }).toThrow(TypeError)
    expect(RULES.IDLE_GROWTH_1.settleMinutes).toBe(20)
  })

  it('exports both rules by id with the pre-registered defaults', () => {
    expect(Object.keys(RULE_IDS).sort()).toEqual(['IDLE-GROWTH-1', 'MEETING-GROWTH-1'])
    expect(RULE_IDS['IDLE-GROWTH-1']).toBe(RULES.IDLE_GROWTH_1)
    expect(RULE_IDS['MEETING-GROWTH-1']).toBe(RULES.MEETING_GROWTH_1)
    for (const rule of [RULES.IDLE_GROWTH_1, RULES.MEETING_GROWTH_1]) {
      expect(rule.samplingSeconds).toBe(30)
      expect(rule.bucketMinutes).toBe(10)
      expect(rule.memoryMetric).toEqual({ darwin: 'physFootprintBytes', win32: 'privateBytes' })
    }
    expect(RULES.IDLE_GROWTH_1.settleMinutes).toBe(20)
    expect(RULES.MEETING_GROWTH_1.settleMinutes).toBe(5)
  })

  it('covers every census kind, sidecar-supervisor included', () => {
    const censusKinds = new Set<string>([...ATTRIBUTABLE_PROCESS_KINDS, 'utility', 'other'])
    // classifyProcess's catch-all outcomes are census kinds too.
    censusKinds.add(classifyProcess({ pid: 1, role: 'unknown-helper', commandLine: '--type=utility' }))
    censusKinds.add(classifyProcess({ pid: 1, role: 'unknown-binary', commandLine: '' }))
    for (const rule of [RULES.IDLE_GROWTH_1, RULES.MEETING_GROWTH_1]) {
      expect(new Set(rule.kinds)).toEqual(censusKinds)
      expect(rule.kinds).toContain('sidecar-supervisor')
      expect(rule.supervisorKind).toBe('sidecar-supervisor')
    }
  })
})
