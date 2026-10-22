import { describe, expect, it } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { readModuleSource } from '../../../../test-helpers/module-source'
import { teamFolderAddError } from './MeetingsTab'

describe('teamFolderAddError (D9-10)', () => {
  it('returns the refusal message so it can sit inline next to the control', () => {
    expect(
      teamFolderAddError({
        ok: false,
        reason: 'overlaps-meetings',
        message: 'That folder is already where your own meetings are saved.'
      })
    ).toBe('That folder is already where your own meetings are saved.')
  })

  it('returns null for a settings snapshot (added, cancelled or signed out)', () => {
    expect(teamFolderAddError({ resolvedMeetingsFolder: '/m' } as PublicSettings)).toBeNull()
  })
})

describe('MeetingsTab team-folder control (D9-10)', () => {
  const { text } = readModuleSource(__dirname, './MeetingsTab')
  const source = text.replace(/\r\n/g, '\n')

  it('renders the refusal inline as an alert beside Add shared folder, never a native dialog', () => {
    expect(source).toMatch(/teamFolderAddError\(await window\.toto\.addTeamTranscriptFolder\(\)\)/)
    expect(source).toMatch(/teamFolderErr &&[\s\S]*role="alert"[\s\S]*\{teamFolderErr\}/)
    expect(source).not.toMatch(/\balert\(|\bwindow\.alert/)
  })
})
