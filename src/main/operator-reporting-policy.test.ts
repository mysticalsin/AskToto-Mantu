import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPERATOR_REPORTING_POLICY_TTL_MS,
  configureOperatorReportingPolicy,
  getOperatorReportingPolicy,
  noteUserScopeReportingPolicy,
  onOperatorReportingPolicyChange,
  operatorReportingAllowed,
  operatorReportingPolicyFromAdminContent
} from './operator-reporting-policy'

afterEach(() => configureOperatorReportingPolicy(null))

describe('operatorReportingPolicyFromAdminContent (O10 kill switch)', () => {
  it('allows reporting by default, with no file, an empty file or other keys', () => {
    expect(operatorReportingPolicyFromAdminContent(null)).toEqual({ allowed: true })
    expect(operatorReportingPolicyFromAdminContent('{}')).toEqual({ allowed: true })
    expect(operatorReportingPolicyFromAdminContent('{"requireAuth":true}')).toEqual({ allowed: true })
    expect(operatorReportingPolicyFromAdminContent('not json')).toEqual({ allowed: true })
  })
  it('turns off only for the literal boolean false', () => {
    expect(operatorReportingPolicyFromAdminContent('{"operatorReporting":false}')).toEqual({
      allowed: false,
      reason: 'admin-policy'
    })
    for (const v of ['"false"', '0', 'null', 'true']) {
      expect(operatorReportingPolicyFromAdminContent(`{"operatorReporting":${v}}`)).toEqual({ allowed: true })
    }
  })
})

describe('configured policy', () => {
  it('is allowed until readers are configured', () => {
    expect(operatorReportingAllowed()).toBe(true)
  })
  it('honours the admin file and never reads a user-scope value', () => {
    const readAdmin = vi.fn(() => '{"operatorReporting":false}')
    configureOperatorReportingPolicy({ readAdmin })
    expect(operatorReportingAllowed()).toBe(false)
    configureOperatorReportingPolicy({ readAdmin: () => null })
    expect(operatorReportingAllowed()).toBe(true)
  })
  it('audits a user-scope key once and ignores it', () => {
    const audit = vi.fn()
    configureOperatorReportingPolicy({ readAdmin: () => null, audit })
    expect(noteUserScopeReportingPolicy('{"operatorReporting":false}')).toBe(true)
    expect(noteUserScopeReportingPolicy('{"operatorReporting":false}')).toBe(false)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('operator.reporting.policy_ignored_user_scope', {})
    expect(operatorReportingAllowed()).toBe(true)
  })
  it('does not audit a user file without the key', () => {
    const audit = vi.fn()
    configureOperatorReportingPolicy({ readAdmin: () => null, audit })
    expect(noteUserScopeReportingPolicy('{"operatorUrl":"https://x.example"}')).toBe(false)
    expect(noteUserScopeReportingPolicy(null)).toBe(false)
    expect(audit).not.toHaveBeenCalled()
  })
  it('answers from memory inside the TTL and notices a change after it', () => {
    let content: string | null = null
    const readAdmin = vi.fn(() => content)
    configureOperatorReportingPolicy({ readAdmin })
    const changes: boolean[] = []
    onOperatorReportingPolicyChange((a) => changes.push(a))
    expect(getOperatorReportingPolicy(1_000).allowed).toBe(true)
    content = '{"operatorReporting":false}'
    expect(getOperatorReportingPolicy(1_000 + OPERATOR_REPORTING_POLICY_TTL_MS - 1).allowed).toBe(true)
    expect(readAdmin).toHaveBeenCalledTimes(1)
    expect(getOperatorReportingPolicy(1_000 + OPERATOR_REPORTING_POLICY_TTL_MS).allowed).toBe(false)
    expect(changes).toEqual([false])
  })
  it('a throwing reader leaves reporting allowed', () => {
    configureOperatorReportingPolicy({
      readAdmin: () => {
        throw new Error('EACCES')
      }
    })
    expect(operatorReportingAllowed()).toBe(true)
  })
})
