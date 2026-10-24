import { describe, expect, it } from 'vitest'
import {
  INTERRUPTION_PROFILES,
  ProactiveControls,
  novelty,
  noveltyTokens,
  playbookFingerprint
} from './proactive-controls'

const MIN = 60_000
const clock = () => {
  const state = { t: 1_000_000 }
  return { state, now: () => state.t }
}

describe('interruption profiles', () => {
  it('profiles are frozen and describe every mode', () => {
    expect(Object.keys(INTERRUPTION_PROFILES).sort()).toEqual(['manual', 'questions'])
    expect(Object.isFrozen(INTERRUPTION_PROFILES)).toBe(true)
    for (const profile of Object.values(INTERRUPTION_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true)
      expect(Object.isFrozen(profile.autoTriggers)).toBe(true)
      expect(profile.cooldown).toBe('suggestEverySec')
      expect(profile.visibleMs).toBeNull()
      expect(profile.interruptible).toBe(false)
    }
    expect(INTERRUPTION_PROFILES.questions).toMatchObject({
      autoTriggers: ['question'],
      budgetMax: 6,
      budgetWindowMs: 10 * MIN,
      minNovelty: 0.35
    })
  })

  it('manual allows no automatic trigger', () => {
    expect(INTERRUPTION_PROFILES.manual.autoTriggers).toEqual([])
    expect(INTERRUPTION_PROFILES.manual.budgetMax).toBe(0)
    const c = clock()
    const controls = new ProactiveControls(c.now)
    expect(controls.reserve('meeting-1', 'manual')).toBeNull()
  })
})

describe('trigger budget', () => {
  it('reserve admits 6 then refuses the 7th within 10 minutes', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    for (let i = 0; i < 6; i++) {
      const r = controls.reserve('meeting-1', 'questions')
      expect(r).not.toBeNull()
      controls.commit(r!, `question number ${i}`)
      c.state.t += 10_000
    }
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
  })

  it('slot frees after the window rolls', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    for (let i = 0; i < 6; i++) controls.commit(controls.reserve('meeting-1', 'questions')!, `q ${i}`)
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
    c.state.t += 10 * MIN + 1
    expect(controls.reserve('meeting-1', 'questions')).not.toBeNull()
  })

  it('pending reservations count toward the budget', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    const held = Array.from({ length: 6 }, () => controls.reserve('meeting-1', 'questions'))
    expect(held.every((r) => r !== null)).toBe(true)
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
  })

  it('release refunds and commit consumes', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    const rs = Array.from({ length: 6 }, () => controls.reserve('meeting-1', 'questions')!)
    controls.release(rs[0])
    const again = controls.reserve('meeting-1', 'questions')
    expect(again).not.toBeNull()
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
    controls.commit(again!, 'committed question')
    controls.release(rs[1])
    expect(controls.reserve('meeting-1', 'questions')).not.toBeNull()
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
    // a released reservation cannot be released or committed twice
    controls.release(rs[1])
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
  })

  it('new sessionId resets budget and ring', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    for (let i = 0; i < 6; i++) controls.commit(controls.reserve('meeting-1', 'questions')!, 'what is the price')
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
    expect(controls.noveltyOf('meeting-1', 'what is the price')).toBeLessThan(0.35)
    expect(controls.reserve('meeting-2', 'questions')).not.toBeNull()
    expect(controls.noveltyOf('meeting-2', 'what is the price')).toBe(1)
  })
})

describe('novelty', () => {
  it('tokenizes with NFKC, lower case and letters and digits only', () => {
    expect([...noveltyTokens('Qual é o PREÇO, hoje?')].sort()).toEqual(['hoje', 'o', 'preço', 'qual', 'é'])
    expect(noveltyTokens('   ?!  ').size).toBe(0)
  })

  it('novelty is 1 for empty ring or empty text', () => {
    expect(novelty('what is the price', [])).toBe(1)
    expect(novelty('', [noveltyTokens('what is the price')])).toBe(1)
    expect(novelty('?!', [noveltyTokens('what is the price')])).toBe(1)
  })

  it('near-duplicate question (EN, FR, PT-BR accents, case, punctuation) scores below 0.35', () => {
    const pairs: Array<[string, string]> = [
      ['What is the price for the enterprise plan?', 'what is the price for the enterprise plan'],
      ['Quel est le prix du forfait entreprise ?', 'quel est le PRIX du forfait entreprise'],
      ['Qual é o preço do plano empresarial?', 'Qual é o preço do plano empresarial, por favor?']
    ]
    for (const [a, b] of pairs) {
      expect(novelty(b, [noveltyTokens(a)]), `${a} / ${b}`).toBeLessThan(0.35)
    }
  })

  it('distinct question scores at or above 0.35', () => {
    const ring = [noveltyTokens('What is the price for the enterprise plan?')]
    expect(novelty('How many seats does the team need for onboarding?', ring)).toBeGreaterThanOrEqual(0.35)
  })

  it('ring keeps the last 8', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    const texts = Array.from({ length: 9 }, (_, i) => `unique${i} alpha${i} beta${i} gamma${i}`)
    for (const text of texts) {
      const r = controls.reserve('meeting-1', 'questions')
      controls.commit(r!, text)
      c.state.t += 11 * MIN // keep the budget out of the way
    }
    expect(controls.noveltyOf('meeting-1', texts[0])).toBe(1) // evicted
    expect(controls.noveltyOf('meeting-1', texts[8])).toBe(0)
    expect(controls.noveltyOf('meeting-1', texts[1])).toBe(0)
  })

  it('invalidatePlaybook clears ring but not budget', () => {
    const c = clock()
    const controls = new ProactiveControls(c.now)
    for (let i = 0; i < 6; i++) controls.commit(controls.reserve('meeting-1', 'questions')!, 'repeat this question')
    controls.invalidatePlaybook()
    expect(controls.noveltyOf('meeting-1', 'repeat this question')).toBe(1)
    expect(controls.reserve('meeting-1', 'questions')).toBeNull()
  })
})

describe('playbookFingerprint', () => {
  const base = {
    mode: 'sales',
    modePrompts: { sales: 'sell it', general: 'help' },
    customModes: [{ id: 'sales', label: 'Sales' }],
    suggestEverySec: 8
  }

  it('changes on mode, modePrompts[mode] or customModes entry, and not on unrelated settings', () => {
    const f = playbookFingerprint(base)
    expect(playbookFingerprint({ ...base })).toBe(f)
    expect(playbookFingerprint({ ...base, suggestEverySec: 30 })).toBe(f)
    expect(playbookFingerprint({ ...base, modePrompts: { ...base.modePrompts, general: 'other' } })).toBe(f)
    expect(playbookFingerprint({ ...base, mode: 'general' })).not.toBe(f)
    expect(playbookFingerprint({ ...base, modePrompts: { ...base.modePrompts, sales: 'sell more' } })).not.toBe(f)
    expect(playbookFingerprint({ ...base, customModes: [{ id: 'sales', label: 'Sales team' }] })).not.toBe(f)
  })

  it('treats absent prompts and modes as empty', () => {
    expect(playbookFingerprint({ mode: 'general' })).toBe(playbookFingerprint({ mode: 'general', modePrompts: {} }))
  })
})
