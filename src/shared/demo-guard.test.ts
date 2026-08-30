import { describe, expect, it } from 'vitest'
import { ONBOARDING_DEMO_TAG, isDemoTagged, refuseIfDemoTagged, tagAsDemo } from './demo-guard'

describe('MQA-278 — onboarding-demo persistence guard (isDemoTagged / refuseIfDemoTagged)', () => {
  it('tagAsDemo prefixes with the reserved marker, and isDemoTagged recognizes the result', () => {
    const tagged = tagAsDemo('Renewal check-in')
    expect(tagged.startsWith(ONBOARDING_DEMO_TAG)).toBe(true)
    expect(isDemoTagged(tagged)).toBe(true)
  })

  it('never flags an ordinary, real meeting title/mode/question as demo data', () => {
    expect(isDemoTagged('Quarterly review')).toBe(false)
    expect(isDemoTagged('general')).toBe(false)
    expect(isDemoTagged('sales')).toBe(false)
    // Not even a real meeting that happens to be ABOUT a demo — only the reserved prefix counts.
    expect(isDemoTagged('Demo: Q3 renewal walkthrough')).toBe(false)
  })

  it('isDemoTagged checks every argument, and tolerates null/undefined', () => {
    expect(isDemoTagged(undefined, null, 'real title', tagAsDemo('x'))).toBe(true)
    expect(isDemoTagged(undefined, null, 'real title')).toBe(false)
    expect(isDemoTagged()).toBe(false)
  })

  it('refuseIfDemoTagged throws for tagged input and names the call site + MQA-278', () => {
    expect(() => refuseIfDemoTagged('saveMeeting', tagAsDemo('fake meeting'))).toThrow(/saveMeeting/)
    expect(() => refuseIfDemoTagged('saveMeeting', tagAsDemo('fake meeting'))).toThrow(/MQA-278/)
  })

  it('refuseIfDemoTagged is a no-op for real data — it must never block a genuine save', () => {
    expect(() => refuseIfDemoTagged('saveMeeting', 'Quarterly review', 'general')).not.toThrow()
  })

  it('refuseIfDemoTagged catches the tag on ANY checked field, not just the first', () => {
    expect(() => refuseIfDemoTagged('saveNote', 'real title', 'real question', tagAsDemo('general'))).toThrow()
  })
})
