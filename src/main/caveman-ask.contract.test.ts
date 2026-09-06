import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasLockedCaveman,
  hasLockedHumanizer,
  lockedCavemanIntensityIn,
  lockedModeSkillIdIn
} from '@shared/mode-skills'
import { AUTO_CLARITY_DIRECTIVE, DEFAULT_ASK_CAVEMAN, applyCaveman } from '@shared/caveman-ask'
import { userText } from './llm/shared'
import { buildSystem } from './personas'
import { loadVerifiedSkill } from './mode-skills'
import type { AskStart, Profile } from '@shared/ipc'

const EMPTY_PROFILE: Profile = { name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' }
const req = (mode: AskStart['mode'], prompt = 'Why React re-render?'): AskStart =>
  ({ id: 'x', mode, prompt, history: [] }) as AskStart

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const appSrc = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

describe('Ask caveman — Métis header + lock path', () => {
  it('uses Métis YAML (id / version / locked), not Claude name/description frontmatter', () => {
    const raw = loadVerifiedSkill('caveman').raw
    expect(raw.startsWith('---\nid: caveman\nversion: 1.0.0\nlocked: true\n---\n')).toBe(true)
    expect(raw).not.toMatch(/^---\nname:/)
    expect(raw).not.toMatch(/\ndescription:/)
  })
})

describe('Ask caveman — default on full', () => {
  it('typed Ask injects locked caveman at full by default', () => {
    const s = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [])
    expect(hasLockedCaveman(s)).toBe(true)
    expect(lockedCavemanIntensityIn(s)).toBe(DEFAULT_ASK_CAVEMAN)
    expect(s).toMatch(/ACTIVE REGISTER: full/)
    expect(hasLockedHumanizer(s)).toBe(true)
    expect(lockedModeSkillIdIn(s)).toBe('general')
  })

  it('vision Ask also gets caveman full; suggest / recap / summary do not', () => {
    expect(hasLockedCaveman(buildSystem(req('vision'), 'general', EMPTY_PROFILE, {}, []))).toBe(true)
    expect(hasLockedCaveman(buildSystem(req('suggest'), 'general', EMPTY_PROFILE, {}, []))).toBe(false)
    expect(hasLockedCaveman(buildSystem(req('recap'), 'general', EMPTY_PROFILE, {}, []))).toBe(false)
    expect(hasLockedCaveman(buildSystem(req('summary'), 'general', EMPTY_PROFILE, {}, []))).toBe(false)
  })

  it('custom modes still get caveman on typed Ask, never a fake builtin mode skill', () => {
    const s = buildSystem(req('answer'), 'custom-123', EMPTY_PROFILE, { 'custom-123': 'Be mine.' }, [])
    expect(hasLockedCaveman(s)).toBe(true)
    expect(lockedCavemanIntensityIn(s)).toBe('full')
    expect(lockedModeSkillIdIn(s)).toBeNull()
    expect(hasLockedHumanizer(s)).toBe(true)
  })
})

describe('Ask caveman — off and intensity', () => {
  it('stop caveman / normal mode omit the locked caveman block', () => {
    const off = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [], undefined, undefined, undefined, 'off')
    expect(hasLockedCaveman(off)).toBe(false)
    expect(hasLockedHumanizer(off)).toBe(true)
  })

  it('wires lite / ultra into the register line the model actually sees', () => {
    const lite = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [], undefined, undefined, undefined, 'lite')
    expect(lockedCavemanIntensityIn(lite)).toBe('lite')
    expect(lite).toMatch(/ACTIVE REGISTER: lite/)
    const ultra = buildSystem(req('answer'), 'general', EMPTY_PROFILE, {}, [], undefined, undefined, undefined, 'ultra')
    expect(lockedCavemanIntensityIn(ultra)).toBe('ultra')
  })

  it('fact-check skips caveman with the rest of the live playbook', () => {
    const fact = buildSystem(
      { id: 'x', mode: 'answer', prompt: 'check', history: [], kind: 'factcheck' } as AskStart,
      'interview',
      EMPTY_PROFILE,
      {},
      []
    )
    expect(hasLockedCaveman(fact)).toBe(false)
    expect(hasLockedHumanizer(fact)).toBe(false)
  })
})

describe('Ask caveman — Auto-Clarity', () => {
  it('skill body names the drop cases', () => {
    const body = loadVerifiedSkill('caveman').body
    expect(body).toMatch(/Security warnings/)
    expect(body).toMatch(/Irreversible action confirmations/)
    expect(body).toMatch(/fragment order or omitted conjunctions risk misread/)
    expect(body).toMatch(/Compression itself creates technical ambiguity/)
    expect(body).toMatch(/User asks to clarify or repeats question/)
    expect(body).toMatch(/permanently delete/)
  })

  it('irreversible-warning composed Ask includes a clarity override cue', () => {
    const prompt = 'Write SQL that will permanently delete all rows in the users table'
    const system = buildSystem(req('answer', prompt), 'general', EMPTY_PROFILE, {}, [])
    const user = userText(req('answer', prompt))
    expect(hasLockedCaveman(system)).toBe(true)
    expect(system).toMatch(/Auto-Clarity/)
    expect(user).toContain(AUTO_CLARITY_DIRECTIVE)
    expect(applyCaveman(prompt).dropClarity).toBe(true)
  })

  it('ordinary questions do not get the Auto-Clarity directive', () => {
    expect(userText(req('answer', 'Why React component re-render?'))).not.toContain(AUTO_CLARITY_DIRECTIVE)
  })
})

describe('Ask caveman — command strip + persist (existing Ask/session store)', () => {
  it('askStart parses, persists askCaveman, and strips the command from the prompt', () => {
    expect(indexSrc).toMatch(/applyCaveman\(req\.prompt, s\.askCaveman\)/)
    expect(indexSrc).toMatch(/setSettings\(\{ askCaveman: caveman\.next \}\)/)
    expect(indexSrc).toMatch(/req\.prompt = caveman\.visiblePrompt/)
    expect(indexSrc).not.toMatch(/applyOverlaySkillFile/)
  })

  it('typed Ask submit strips the command from the user-visible question', () => {
    expect(appSrc).toMatch(/applyCaveman\(typed, settings\?\.askCaveman/)
    expect(appSrc).toMatch(/patch\(\{ askCaveman: caveman\.next \}\)/)
    expect(appSrc).toMatch(/const q = caveman\.visiblePrompt/)
  })
})
