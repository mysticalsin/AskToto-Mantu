import { describe, expect, it, vi } from 'vitest'
import type { ConfirmActionInput } from '../../lib/navigation-guard'
import {
  DUST_DISCONNECT_CONFIRMATION,
  DUST_REMOVE_KEY_CONFIRMATION,
  LOG_OUT_CONFIRMATION,
  OUTLOOK_SIGN_OUT_CONFIRMATION,
  REPLAY_ONBOARDING_CONFIRMATION,
  SCREEN_REPAIR_CONFIRMATION,
  retentionDeleteConfirmation,
  retentionDeleteUnknownConfirmation
} from './settings-confirmations'
import { confirmRetentionChange } from './DangerZoneSection'

const ALL: [string, ConfirmActionInput][] = [
  ['log out', LOG_OUT_CONFIRMATION],
  ['replay onboarding', REPLAY_ONBOARDING_CONFIRMATION],
  ['outlook sign out', OUTLOOK_SIGN_OUT_CONFIRMATION],
  ['dust disconnect', DUST_DISCONNECT_CONFIRMATION],
  ['dust remove key', DUST_REMOVE_KEY_CONFIRMATION],
  ['screen repair', SCREEN_REPAIR_CONFIRMATION],
  ['retention (count)', retentionDeleteConfirmation(12, '30 days')],
  ['retention (one)', retentionDeleteConfirmation(1, '90 days')],
  ['retention (unknown)', retentionDeleteUnknownConfirmation('1 year')]
]

describe('Settings confirmations follow the HIG alert rules', () => {
  it.each(ALL)('%s: question title, sentence message, short title-style verb, never Yes/No/OK', (_, c) => {
    expect(c.title).toMatch(/^[A-Z].*\?$/)
    expect(c.title).not.toMatch(/^(Error|Warning)\b/)
    expect(c.message).toMatch(/^[A-ZM0-9].*\.$/)
    expect(c.message).not.toContain('—')
    const words = c.confirmLabel.split(' ')
    expect(words.length).toBeLessThanOrEqual(3)
    for (const word of words) if (word !== 'and') expect(word[0]).toBe(word[0].toUpperCase())
    expect(c.confirmLabel).not.toMatch(/^(Yes|No|OK|Ok)$/)
  })

  it('screen repair warns that a meeting in progress is saved before the relaunch', () => {
    expect(SCREEN_REPAIR_CONFIRMATION.message).toContain('saves any meeting in progress')
    expect(SCREEN_REPAIR_CONFIRMATION.message).toContain('relaunches')
  })

  it('styles only the consequence the person did not choose as destructive', () => {
    const destructive = ALL.filter(([, c]) => c.destructive).map(([name]) => name)
    expect(destructive).toEqual(['retention (count)', 'retention (one)', 'retention (unknown)'])
  })

  it('states the number of meetings a shorter window deletes', () => {
    expect(retentionDeleteConfirmation(12, '30 days')).toMatchObject({
      title: 'Delete 12 older meetings?',
      message:
        "12 saved meetings are older than 30 days. Métis will delete them from this device, and this can't be undone."
    })
    expect(retentionDeleteConfirmation(1, '90 days').title).toBe('Delete 1 older meeting?')
  })
})

describe('confirmRetentionChange', () => {
  const counted = (expired: number) => vi.fn(async () => ({ ok: true as const, expired }))

  it('never asks when retention grows, turns off, or stays the same', async () => {
    const confirm = vi.fn(async () => false)
    const preview = counted(9)
    expect(await confirmRetentionChange(30, 90, confirm, preview)).toBe(true)
    expect(await confirmRetentionChange(30, 0, confirm, preview)).toBe(true)
    expect(await confirmRetentionChange(90, 90, confirm, preview)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
  })

  it('does not ask when the shorter window would delete nothing', async () => {
    const confirm = vi.fn(async () => false)
    expect(await confirmRetentionChange(0, 30, confirm, counted(0))).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks with the count when the shorter window deletes meetings, and honours Cancel', async () => {
    const confirm = vi.fn(async () => false)
    expect(await confirmRetentionChange(365, 30, confirm, counted(4))).toBe(false)
    expect(confirm).toHaveBeenCalledWith(retentionDeleteConfirmation(4, '30 days'))
  })

  it('still asks, without a number, when the count cannot be read', async () => {
    const confirm = vi.fn(async () => true)
    const failing = vi.fn(async () => ({ ok: false as const, error: 'x' }))
    expect(await confirmRetentionChange(0, 180, confirm, failing)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(retentionDeleteUnknownConfirmation('180 days'))
  })
})
