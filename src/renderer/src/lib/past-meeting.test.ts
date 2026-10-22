import { describe, expect, it } from 'vitest'
import {
  pastMeetingMarkers,
  reviewMarkerProps,
  withEditedRecap,
  withGeneratedRecap,
  type PastMeeting
} from './past-meeting'

const meeting: PastMeeting = {
  file: 'a.md',
  title: 'Acme',
  date: '',
  recap: 'Notes',
  lines: [],
  startedAt: 1,
  confidential: false,
  crmPushedKey: 'crm1',
  clickupPushedKey: 'click1',
  nextStepsPushedKeys: ['step1'],
  recapEdited: true
}

describe('past meeting snapshot markers (Q07)', () => {
  it('carries the durable markers from a read to Review, and none for a live meeting', () => {
    expect(
      pastMeetingMarkers({ ok: true, clickupPushedKey: 'c', nextStepsPushedKeys: ['s'], recapEdited: true })
    ).toEqual({
      crmPushedKey: undefined,
      clickupPushedKey: 'c',
      nextStepsPushedKeys: ['s'],
      recapEdited: true
    })
    expect(reviewMarkerProps(meeting)).toEqual({
      crmPushedKey: 'crm1',
      clickupPushedKey: 'click1',
      nextStepsPushedKeys: ['step1'],
      recapEdited: true
    })
    expect(reviewMarkerProps(null).recapEdited).toBe(false)
  })

  it('a saved edit marks the notes edited', () => {
    expect(withEditedRecap({ ...meeting, recapEdited: false }, 'Mine').recapEdited).toBe(true)
  })

  it('a generation clears the flag, but a failed run that wrote the edited text back keeps it', () => {
    expect(withGeneratedRecap(meeting, { text: 'New summary', recapStatus: 'complete' })).toMatchObject({
      recap: 'New summary',
      recapEdited: false
    })
    expect(withGeneratedRecap(meeting, { text: 'Notes', recapStatus: 'incomplete' }).recapEdited).toBe(true)
  })
})
