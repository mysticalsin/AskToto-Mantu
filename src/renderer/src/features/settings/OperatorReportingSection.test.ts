import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PublicSettings } from '@shared/ipc'
import { OPERATOR_REPORTING_DETAIL, OPERATOR_REPORTING_DISCLOSURE } from '@shared/operator'
import { readModuleSource } from '../../../../test-helpers/module-source'
import { OperatorReportingCaption, operatorReportingStatusLine, operatorSourceLine } from './OperatorReportingSection'

describe('Organisation reporting copy (O12)', () => {
  it('pins the owner-approved disclosure sentence verbatim', () => {
    expect(OPERATOR_REPORTING_DISCLOSURE).toBe(
      "Métis reports usage and health, never meeting content, to your organisation's Métis Operator."
    )
  })

  it('names identity and location fields and says content never leaves', () => {
    expect(OPERATOR_REPORTING_DETAIL).toMatch(/work email when you're signed in/)
    expect(OPERATOR_REPORTING_DETAIL).toMatch(/this computer's name/)
    expect(OPERATOR_REPORTING_DETAIL).toMatch(/approximate city/)
    expect(OPERATOR_REPORTING_DETAIL).toMatch(/Audio, transcripts, notes and questions are never sent\./)
    for (const copy of [OPERATOR_REPORTING_DISCLOSURE, OPERATOR_REPORTING_DETAIL]) expect(copy).not.toMatch(/—/)
  })

  it('gives one status line per enrolment state, and treats an unknown state as still connecting', () => {
    expect(operatorReportingStatusLine('enrolled')).toBe('Connected')
    expect(operatorReportingStatusLine('pending')).toBe('Connects automatically when online')
    expect(operatorReportingStatusLine(undefined)).toBe('Connects automatically when online')
    expect(operatorReportingStatusLine('off-by-policy')).toBe('Turned off by your IT administrator')
    expect(operatorReportingStatusLine('revoked')).toBe('This device was removed by your administrator')
  })

  it('labels where the seat came from, and shows nothing before enrolment', () => {
    expect(operatorSourceLine('sso')).toBe('Organisation · SSO')
    expect(operatorSourceLine('token')).toBe('Organisation · Automatic')
    expect(operatorSourceLine('admin')).toBe('Organisation · Licence from IT')
    expect(operatorSourceLine(null)).toBeNull()
  })
})

describe('onboarding reporting caption (O12)', () => {
  const render = (operatorReporting: PublicSettings['operatorReporting'], visible = true): string =>
    renderToStaticMarkup(
      createElement(OperatorReportingCaption, { settings: { operatorReporting } as PublicSettings, visible })
    )

  it('shows the disclosure once the setup scan settles, with no checkbox or switch', () => {
    const html = render('pending')
    expect(html).toContain('Métis reports usage and health, never meeting content')
    expect(html).not.toMatch(/<input|role="switch"|<button/)
    expect(render('enrolled')).toContain('Métis Operator.')
  })

  it('stays hidden before the scan settles and when IT turned reporting off', () => {
    expect(render('pending', false)).toBe('')
    expect(render('off-by-policy')).toBe('')
  })

  it('sits under the setup rows in OnboardingExperience', () => {
    const source = readModuleSource(join(__dirname, '..', '..', 'components'), './OnboardingExperience').text
    expect(source).toMatch(/<OperatorReportingCaption settings=\{settings\} visible=\{scanDone\} \/>/)
  })
})
