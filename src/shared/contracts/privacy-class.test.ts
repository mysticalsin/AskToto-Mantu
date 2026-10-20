import { describe, expect, it } from 'vitest'
import { PRIVACY_CLASS_RULES, PRIVACY_CLASSES, PrivacyClassSchema, mayLeaveDevice, mayLog } from './privacy-class'

describe('privacy classes', () => {
  it('mayLeaveDevice allows P0 and P1 unconditionally', () => {
    expect(mayLeaveDevice('P0', { userConsented: false })).toBe(true)
    expect(mayLeaveDevice('P1', { userConsented: false })).toBe(true)
  })

  it('mayLeaveDevice allows P2 only with user consent', () => {
    expect(mayLeaveDevice('P2', { userConsented: true })).toBe(true)
    expect(mayLeaveDevice('P2', { userConsented: false })).toBe(false)
  })

  it('mayLeaveDevice never allows P3 or P4 even with consent', () => {
    expect(mayLeaveDevice('P3', { userConsented: true })).toBe(false)
    expect(mayLeaveDevice('P4', { userConsented: true })).toBe(false)
  })

  it('mayLog allows only P0 and P1', () => {
    expect(mayLog('P0')).toBe(true)
    expect(mayLog('P1')).toBe(true)
    expect(mayLog('P2')).toBe(false)
    expect(mayLog('P3')).toBe(false)
    expect(mayLog('P4')).toBe(false)
  })

  it('PRIVACY_CLASS_RULES covers every class', () => {
    expect(Object.keys(PRIVACY_CLASS_RULES).sort()).toEqual([...PRIVACY_CLASSES].sort())
    for (const cls of PRIVACY_CLASSES) {
      expect(PRIVACY_CLASS_RULES[cls].contents.length).toBeGreaterThan(0)
      expect(PRIVACY_CLASS_RULES[cls].rule.length).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(PRIVACY_CLASS_RULES)).toBe(true)
  })

  it('schema rejects unknown classes', () => {
    for (const bad of ['P5', 'p0', '', 'P', 0, null]) {
      expect(PrivacyClassSchema.safeParse(bad).success).toBe(false)
    }
    expect(PrivacyClassSchema.safeParse('P3').success).toBe(true)
  })
})
