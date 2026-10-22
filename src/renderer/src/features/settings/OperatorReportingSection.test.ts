import { describe, expect, it } from 'vitest'
import { OPERATOR_REPORTING_DETAIL, OPERATOR_REPORTING_DISCLOSURE } from '@shared/operator'
import { operatorReportingStatusLine, operatorSourceLine } from './OperatorReportingSection'

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
