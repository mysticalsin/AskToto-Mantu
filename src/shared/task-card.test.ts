import { describe, expect, it } from 'vitest'
import { TaskCardListSchema, taskCardAnnouncement, taskCardCopy, type TaskCardView } from './task-card'

const card = (over: Partial<TaskCardView> = {}): TaskCardView => ({
  cardId: 'c0ffee00c0ffee00c0ffee00c0ffee00',
  actionId: 'desktop.create_note',
  phase: 'running',
  stoppable: true,
  dismissible: false,
  ...over
})

describe('taskCardCopy (G33): what the card says, never the arguments', () => {
  it('names the action from main’s label map and states each phase honestly', () => {
    expect(taskCardCopy(card({ phase: 'queued' }))).toEqual({
      title: 'Create note',
      status: 'Waiting for the current task'
    })
    expect(taskCardCopy(card())).toEqual({ title: 'Create note', status: 'Working…' })
    expect(taskCardCopy(card({ phase: 'stopping', stoppable: false })).status).toBe(
      'Stopping. Anything already done stays done.'
    )
    expect(taskCardCopy(card({ phase: 'done' })).status).toBe('Done.')
    expect(taskCardCopy(card({ phase: 'not_done' })).status).toBe('Nothing was done.')
    expect(taskCardCopy(card({ phase: 'not_done', reason: 'stopped_before_start' })).status).toBe(
      'Stopped before it started.'
    )
    expect(taskCardCopy(card({ phase: 'uncertain' })).status).toBe(
      "Métis can't confirm this finished. Check before trying again."
    )
  })

  it('shows a step count only when the total is known, never a made-up percentage', () => {
    expect(taskCardCopy(card({ step: { done: 1, total: 3 } })).status).toBe('Step 2 of 3')
    expect(taskCardCopy(card({ step: { done: 3, total: 3 } })).status).toBe('Working…')
  })

  it('falls back to a neutral title for an action id it does not know', () => {
    expect(taskCardCopy(card({ actionId: 'desktop.unknown' })).title).toBe('Desktop action')
  })

  it('announces uncertainty assertively and everything else politely', () => {
    expect(taskCardAnnouncement(card({ phase: 'uncertain' })).politeness).toBe('assertive')
    expect(taskCardAnnouncement(card({ phase: 'done' }))).toEqual({ politeness: 'polite', text: 'Create note. Done.' })
  })
})

describe('TaskCardListSchema: the only shape the renderer accepts from main', () => {
  it('accepts a list of cards', () => {
    expect(TaskCardListSchema.safeParse([card(), card({ phase: 'done', stoppable: false })]).success).toBe(true)
  })

  it('rejects extra fields, so a task id, args hash or owner can never ride along', () => {
    for (const extra of [{ taskId: 'desktop-action:p1' }, { argsHash: 'abc' }, { owner: 'webContents:3' }]) {
      expect(TaskCardListSchema.safeParse([{ ...card(), ...extra }]).success).toBe(false)
    }
  })

  it('rejects a malformed card id, an unknown phase and an impossible step', () => {
    expect(TaskCardListSchema.safeParse([card({ cardId: '../x' })]).success).toBe(false)
    expect(TaskCardListSchema.safeParse([{ ...card(), phase: 'exploded' }]).success).toBe(false)
    expect(TaskCardListSchema.safeParse([card({ step: { done: 4, total: 3 } })]).success).toBe(false)
  })

  it('caps the list', () => {
    expect(TaskCardListSchema.safeParse(Array.from({ length: 33 }, () => card())).success).toBe(false)
  })
})
