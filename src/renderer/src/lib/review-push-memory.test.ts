import { describe, expect, it } from 'vitest'
import {
  clickupPayloadKey,
  clickupPushDone,
  markClickupPushed,
  markNextStepPushed,
  nextStepPushKey,
  nextStepPushed,
  seedClickupPushed,
  seedNextStepsPushed,
  type CrmPayload,
  type NextStepArgs
} from './review-push-memory'

// Q07 (D4-6): ClickUp's "sent" state was component state, so leaving Review and coming back re-offered the push
// and a second Confirm created a duplicate task. The module memory now outlives the component, and the durable
// meeting marker seeds it after a relaunch.
describe('ClickUp push memory', () => {
  const payload = (name: string): CrmPayload => ({
    title: name,
    date: '2026-06-12T09:00:00.000Z',
    summary: `## Overview\nNotes for ${name}.`
  })

  it('a ClickUp push that landed is remembered across a remount', () => {
    const p = payload('acme pricing review')
    expect(clickupPushDone('idle', p)).toBe(false)
    expect(clickupPushDone('error', p)).toBe(false)
    markClickupPushed(p)
    // A remount resets the component phase to idle; the memory still answers.
    expect(clickupPushDone('idle', p)).toBe(true)
  })

  it('is seeded from the durable marker so a push made before a relaunch is known', () => {
    const p = payload('globex kickoff')
    expect(clickupPushDone('idle', p)).toBe(false)
    seedClickupPushed(clickupPayloadKey(p))
    expect(clickupPushDone('idle', p)).toBe(true)
  })

  it('re-arms when the recap changed, and never follows the user to another meeting', () => {
    const p = payload('initech discovery')
    markClickupPushed(p)
    expect(clickupPushDone('idle', { ...p, summary: `${p.summary}\n- new action item` })).toBe(false)
    expect(clickupPushDone('idle', payload('some other meeting'))).toBe(false)
  })

  it('keys fit the frontmatter scalar contract main enforces', () => {
    expect(clickupPayloadKey(payload('has: a colon\nand a newline'))).toMatch(/^[a-z0-9]{1,32}$/)
  })
})

describe('next-steps push memory seeded from the durable marker', () => {
  const args: NextStepArgs = { title: 'Send the deck', description: 'Send the deck\n\nFrom meeting: Q3 sync' }

  it('a next step that landed before a relaunch is still known', () => {
    expect(nextStepPushed('idle', 'plane', args)).toBe(false)
    seedNextStepsPushed([nextStepPushKey('plane', args)])
    expect(nextStepPushed('idle', 'plane', args)).toBe(true)
    expect(nextStepPushed('idle', 'clickup', args)).toBe(false)
  })

  it('exposes a key that fits the frontmatter scalar contract', () => {
    expect(nextStepPushKey('plane', { ...args, project_id: 'proj: 1\n2' })).toMatch(/^[a-z0-9]{1,32}$/)
  })

  it('marking a push uses the same identity as the durable key', () => {
    const other: NextStepArgs = { title: 'Book the venue', description: 'Book the venue' }
    markNextStepPushed('plane', other)
    seedNextStepsPushed([nextStepPushKey('plane', other)])
    expect(nextStepPushed('idle', 'plane', other)).toBe(true)
  })
})
