import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfirmSheet } from './ConfirmSheet'
import type { NavigationGuardRequest } from '../lib/navigation-guard'

const request = (extra: Partial<NavigationGuardRequest> = {}): NavigationGuardRequest => ({
  id: 1,
  title: 'Save recap changes?',
  message: 'You have unsaved edits in this recap.',
  saveLabel: 'Save',
  discardLabel: 'Discard',
  cancelLabel: 'Cancel',
  ...extra
})

const marked = (html: string): number => (html.match(/data-metis-meeting-start/g) ?? []).length

describe('ConfirmSheet when the choice starts a meeting', () => {
  it('marks Save and Discard, never Cancel, so a trusted click on either mints the start activation', () => {
    const html = renderToStaticMarkup(<ConfirmSheet request={request({ startsMeeting: true })} onChoose={() => {}} />)
    expect(marked(html)).toBe(2)
    const cancel = html.slice(html.indexOf('Cancel') - 400, html.indexOf('Cancel') + 10)
    expect(cancel).not.toContain('data-metis-meeting-start')
  })

  it('marks nothing for an ordinary navigation guard', () => {
    const html = renderToStaticMarkup(<ConfirmSheet request={request()} onChoose={() => {}} />)
    expect(marked(html)).toBe(0)
  })

  it('marks the single action of a two-button confirmation too', () => {
    const html = renderToStaticMarkup(
      <ConfirmSheet request={request({ kind: 'confirm', startsMeeting: true })} onChoose={() => {}} />
    )
    expect(marked(html)).toBe(1)
  })
})
