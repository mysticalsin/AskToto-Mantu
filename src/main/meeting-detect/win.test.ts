import { describe, it, expect } from 'vitest'
import { nativeWindowMatches, TEAMS_TOKENS, SLACK_TOKENS } from './win'

describe('nativeWindowMatches', () => {
  it('detects a Microsoft Teams meeting window', () => {
    expect(nativeWindowMatches('Teams', 'Q4 Review — Teams meeting')).toBe(true)
    expect(nativeWindowMatches('Teams', 'Microsoft Teams call')).toBe(true)
    expect(nativeWindowMatches('Teams', 'Teams Call')).toBe(true)
  })

  it('detects a Slack huddle window', () => {
    expect(nativeWindowMatches('Slack', 'Project — Slack | huddle')).toBe(true)
    expect(nativeWindowMatches('Slack', 'slack call')).toBe(true)
    expect(nativeWindowMatches('Slack', 'engineering huddle')).toBe(true)
  })

  it('detects a Zoom meeting window', () => {
    expect(nativeWindowMatches('zoom', 'Zoom Meeting')).toBe(true)
  })

  it('detects Webex / GoToMeeting', () => {
    expect(nativeWindowMatches('webex', 'Webex')).toBe(true)
    expect(nativeWindowMatches('g2m', 'GoTo Meeting')).toBe(true)
  })

  it('rejects Teams chat-only windows', () => {
    expect(nativeWindowMatches('Teams', 'General | Microsoft Teams')).toBe(false)
    expect(nativeWindowMatches('Teams', 'Chat | Microsoft Teams')).toBe(false)
  })

  it('rejects Slack chat-only windows', () => {
    expect(nativeWindowMatches('Slack', '#general')).toBe(false)
    expect(nativeWindowMatches('Slack', 'Project | Slack')).toBe(false)
  })

  it('rejects unrelated apps', () => {
    expect(nativeWindowMatches('Code', 'main.ts - AskToto')).toBe(false)
    expect(nativeWindowMatches('chrome', 'Google')).toBe(false)
  })

  it('uses realistic title formats', () => {
    expect(nativeWindowMatches('Teams', 'Q4 Review | Microsoft Teams call')).toBe(true)
    expect(nativeWindowMatches('Teams', 'Q4 Review meeting | Microsoft Teams')).toBe(true)
    expect(nativeWindowMatches('Slack', 'huddle | Slack')).toBe(true)
  })

  it('detects user-supplied custom meeting apps', () => {
    expect(nativeWindowMatches('around', 'Weekly standup', ['Around'])).toBe(true)
    expect(nativeWindowMatches('chime', 'Client call', ['Chime'])).toBe(true)
    expect(nativeWindowMatches('Code', 'main.ts - AskToto', ['Around'])).toBe(false)
  })
})

describe('token lists', () => {
  it('contains expected Teams tokens', () => {
    expect(TEAMS_TOKENS).toContain('teams meeting')
    expect(TEAMS_TOKENS).toContain('microsoft teams call')
    expect(TEAMS_TOKENS).toContain('teams call')
  })

  it('contains expected Slack tokens', () => {
    expect(SLACK_TOKENS).toContain('slack | huddle')
    expect(SLACK_TOKENS).toContain('slack call')
    expect(SLACK_TOKENS).toContain('huddle')
  })
})
