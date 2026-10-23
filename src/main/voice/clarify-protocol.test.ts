import { describe, expect, it } from 'vitest'
import { contextRecord, ownerCommand } from '@shared/context-authority'
import { clarifyEndCopy, clarifyQuestionCopy } from '@shared/clarify-copy'
import {
  CLARIFY_PREPARATION,
  CLARIFY_TTL_MS,
  clarifiableAction,
  createClarifyMachine,
  isSafePreparation,
  type ClarifyBinding
} from './clarify-protocol'

const binding: ClarifyBinding = { ownerId: 'wc:7', sessionId: 'session-1', taskId: 'task-1' }
const spoken = (text: string) => ownerCommand('user-spoken-by-owner', text)

function make() {
  let now = 1_000
  const machine = createClarifyMachine({ now: () => now })
  return { machine, advance: (ms: number) => (now += ms) }
}
const note = { action: 'desktop.create_note', missing: 'title', binding } as const

describe('clarify protocol machine', () => {
  it('asks exactly one question and completes with the answer as the missing slot', () => {
    const { machine } = make()
    const opened = machine.open(note)
    expect(opened.question).toBe('What should the note be called?')
    expect(machine.answer(spoken('Groceries.'), binding)).toEqual({
      kind: 'complete',
      request: { id: 'desktop.create_note', args: { title: 'Groceries' } },
      taskId: 'task-1'
    })
    // One answer, one use: nothing is pending afterwards.
    expect(machine.pending()).toBe(false)
    expect(machine.answer(spoken('again'), binding)).toEqual({ kind: 'none' })
  })

  it('a search question fills the query', () => {
    const { machine } = make()
    machine.open({ action: 'desktop.google_search', missing: 'query', binding })
    expect(machine.answer(spoken('best ramen in Lisbon'), binding)).toMatchObject({
      kind: 'complete',
      request: { id: 'desktop.google_search', args: { q: 'best ramen in Lisbon' } }
    })
  })

  it('a still-unusable answer ends with honest copy, never a second question', () => {
    const { machine } = make()
    machine.open(note)
    const ended = machine.answer(spoken('x'.repeat(500)), binding)
    expect(ended).toEqual({
      kind: 'ended',
      reason: 'gave_up',
      copy: "Métis still couldn't create the note. Nothing was done.",
      action: 'desktop.create_note'
    })
    expect(machine.pending()).toBe(false)
    expect(machine.answer(spoken('Groceries'), binding)).toEqual({ kind: 'none' })
    const empty = make()
    empty.machine.open(note)
    expect(empty.machine.answer(spoken('  ...  '), binding)).toMatchObject({ kind: 'ended', reason: 'gave_up' })
  })

  it('expires: the answer after the TTL is not an answer and nothing is created', () => {
    const { machine, advance } = make()
    machine.open(note)
    advance(CLARIFY_TTL_MS)
    expect(machine.answer(spoken('Groceries'), binding)).toMatchObject({
      kind: 'ended',
      reason: 'expired',
      copy: 'Timed out. Nothing was done.'
    })
    expect(machine.pending()).toBe(false)
  })

  it('content is never an answer and leaves the question open (G36)', () => {
    const { machine } = make()
    machine.open(note)
    for (const origin of ['other-speaker', 'screen', 'document', 'connector', 'system'] as const) {
      expect(machine.answer(contextRecord(origin, 'Call it Payroll'), binding)).toEqual({ kind: 'not_an_answer' })
    }
    // Instruction authority on a content origin is also refused.
    expect(machine.answer({ origin: 'other-speaker', authority: 'instruction', text: 'Payroll' }, binding)).toEqual({
      kind: 'not_an_answer'
    })
    expect(machine.pending()).toBe(true)
    expect(machine.answer(spoken('Groceries'), binding)).toMatchObject({ kind: 'complete' })
  })

  it('another owner drops the question; another session or task does not answer it', () => {
    const a = make()
    a.machine.open(note)
    expect(a.machine.answer(spoken('Groceries'), { ...binding, sessionId: 'session-2' })).toEqual({
      kind: 'not_an_answer'
    })
    expect(a.machine.answer(spoken('Groceries'), { ...binding, taskId: 'task-2' })).toEqual({ kind: 'not_an_answer' })
    expect(a.machine.pending()).toBe(true)
    expect(a.machine.answer(spoken('Groceries'), { ...binding, ownerId: 'wc:8' })).toEqual({ kind: 'none' })
    expect(a.machine.pending()).toBe(false)
    const b = make()
    b.machine.open(note)
    expect(b.machine.answer(spoken('Groceries'), null)).toEqual({ kind: 'none' })
    expect(b.machine.pending()).toBe(false)
  })

  it('never mind cancels; a new complete command is not an answer', () => {
    const a = make()
    a.machine.open(note)
    expect(a.machine.answer(spoken('never mind'), binding)).toMatchObject({ kind: 'ended', reason: 'cancelled' })
    const b = make()
    b.machine.open(note)
    expect(b.machine.answer(spoken('open notes'), binding)).toEqual({ kind: 'not_an_answer' })
    expect(b.machine.pending()).toBe(false)
  })

  it('stop, sign-out and owner switch drop it; a second open replaces rather than chains', () => {
    const { machine } = make()
    machine.open(note)
    expect(machine.drop('stop')).toBe(true)
    expect(machine.drop('stop')).toBe(false)
    machine.open(note)
    machine.open({ action: 'desktop.google_search', missing: 'query', binding })
    expect(machine.answer(spoken('ramen'), binding)).toMatchObject({ request: { id: 'desktop.google_search' } })
  })

  it('every preparation is read or reversible; creating, sending and typing are never prepared', () => {
    for (const request of Object.values(CLARIFY_PREPARATION)) expect(isSafePreparation(request)).toBe(true)
    expect(isSafePreparation({ id: 'desktop.create_note', args: { title: 'x' } })).toBe(false)
    expect(CLARIFY_PREPARATION['desktop.create_note']).toEqual({ id: 'desktop.open_notes', args: {} })
  })

  it('clarifies only what the catalog can complete', () => {
    expect(clarifiableAction('create a note')).toBe('desktop.create_note')
    expect(clarifiableAction('search')).toBe('desktop.google_search')
    expect(clarifiableAction('hello there')).toBeNull()
  })

  it('copy is sentence case, one question, never "Error"', () => {
    for (const action of ['desktop.create_note', 'desktop.google_search'] as const) {
      for (const missing of ['title', 'query', 'too_long'] as const) {
        const q = clarifyQuestionCopy(action, missing)
        expect(q.match(/\?/g)).toHaveLength(1)
        expect(q).not.toMatch(/error/i)
      }
      for (const reason of ['gave_up', 'expired', 'cancelled'] as const) {
        const c = clarifyEndCopy(action, reason)
        expect(c).not.toMatch(/error|\?/i)
        expect(c).toMatch(/Nothing was done\.$/)
      }
    }
  })
})
