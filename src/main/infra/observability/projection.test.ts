import { describe, expect, it } from 'vitest'
import {
  MAX_MESSAGE_CHARS,
  OBSERVABILITY_EVENTS,
  projectEvent,
  type ObservabilityDetail,
  type ObservabilityEvent
} from './projection'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const isoTime = '2026-01-01T00:00:00.000Z'

function canonical(kind: unknown): unknown {
  if (Array.isArray(kind)) return kind[0]
  switch (kind) {
    case 'flag':
      return true
    case 'int':
      return 7
    case 'num':
      return 1.25
    case 'ms':
      return 12.5
    case 'id':
      return uuid
    case 'version':
      return '2.0.15'
    case 'isoTime':
      return isoTime
    case 'token':
      return 'safe-token_1'
    case 'bundleName':
      return `${uuid}.1700000000000.12000.txt`
    case 'errorText':
      return 'TypeError: failed before content'
    default:
      throw new Error(`unknown kind ${String(kind)}`)
  }
}

const sentinelDetails = [
  { label: 'title', value: 'Board budget review' },
  { label: 'transcript', value: 'Acme said the budget is approved' },
  { label: 'posix', value: '/var/tmp/metis/Meetings/Board budget.md' },
  { label: 'windows', value: 'C:\\Metis\\Meetings\\Board budget.md' },
  { label: 'home', value: '~/Meetings/Board budget.md' },
  { label: 'unc', value: '\\\\server\\Meetings\\Board budget.md' },
  { label: 'file-url', value: 'file:///var/tmp/metis/Meetings/Board%20budget.md' },
  { label: 'https-url', value: 'https://example.test/meetings?title=Board&account=Acme' },
  { label: 'email', value: 'jane.doe@acme.example' },
  { label: 'object', value: { title: 'Board budget', account: 'Acme' } },
  { label: 'array', value: ['Board budget', 'Acme'] }
] as const

const forbiddenMarkers = ['Board', 'Acme', 'acme', 'jane', 'budget', 'Meetings', '@']

function expectContentFree(value: unknown): void {
  const text = JSON.stringify(value)
  for (const marker of forbiddenMarkers) expect(text).not.toContain(marker)
}

describe('observability projection', () => {
  it('keeps each allowlisted field when its canonical kind-valid value is supplied', () => {
    for (const [event, fields] of Object.entries(OBSERVABILITY_EVENTS) as [ObservabilityEvent, Record<string, unknown>][]) {
      const detail: Record<string, unknown> = {}
      for (const [field, kind] of Object.entries(fields)) detail[field] = canonical(kind)

      expect(projectEvent(event, detail)).toEqual(detail)
    }
  })

  it('drops unknown keys', () => {
    expect(projectEvent('app.crash', { kind: 'boot', fatal: false, unknown: 'value' })).toEqual({
      kind: 'boot',
      fatal: false
    })
  })

  it('sweeps every event field against content-bearing sentinels', () => {
    for (const [event, fields] of Object.entries(OBSERVABILITY_EVENTS) as [ObservabilityEvent, Record<string, unknown>][]) {
      for (const [field, kind] of Object.entries(fields)) {
        for (const sentinel of sentinelDetails) {
          if (kind === 'errorText' && (sentinel.label === 'title' || sentinel.label === 'transcript')) continue
          expectContentFree(projectEvent(event, { [field]: sentinel.value }))
        }
      }
    }
  })

  it('keeps maximum-shape stall bundle filenames longer than token fields', () => {
    // UUID 36 + two dots 2 + two 15-digit fields 30 + ".txt" 4 = 72 chars; token caps at 64.
    const stalledMs = 123456789012345
    const bundle = `${uuid}.123456789012345.${stalledMs}.txt`

    expect(projectEvent('app.stall.sampled', { bootId: uuid, stalledMs, bundle })).toEqual({
      bootId: uuid,
      stalledMs,
      bundle
    })
  })

  it.each([
    ['ENOENT', "ENOENT: no such file or directory, open '/var/tmp/metis/Meetings/Board budget.md'", 'ENOENT: no such file or directory, open <text>'],
    ['EPERM', 'EPERM: operation not permitted, open C:\\Metis\\Meetings\\Board budget.md', 'EPERM: operation not permitted, open <path>'],
    ['JSON parse', 'SyntaxError: Unexpected token "Acme said budget approved" in JSON', 'SyntaxError: Unexpected token <text> in JSON'],
    ['email', 'Cannot notify jane.doe@acme.example after crash', 'Cannot notify <email> after crash'],
    ['url', 'Fetch failed https://example.test/crash?title=Board%20budget', 'Fetch failed <url>'],
    ['spawn path', 'spawn /opt/Metis Helper.app/Contents/MacOS/helper ENOENT', 'spawn <path>'],
    ['typed error', new TypeError('Cannot render "Board budget"'), 'TypeError: Cannot render <text>']
  ])('scrubs realistic errorText shape: %s', (_name, input, prefix) => {
    const projected = projectEvent('app.crash', { message: input }) as { message: string }
    expect(projected.message).toContain(prefix)
    expectContentFree(projected)
  })

  it('redacts sk-prefixed keys before writing errorText', () => {
    const projected = projectEvent('app.crash', {
      message: 'OpenAI key sk-proj-abcdefghijklmnopqrstuvwxyz123456 was present'
    }) as { message: string }
    expect(projected.message).toContain('[redacted key]')
    expect(projected.message).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('caps errorText at exactly 300 characters', () => {
    const projected = projectEvent('app.crash', { message: `prefix ${'x'.repeat(400)}` }) as { message: string }
    expect(projected.message).toHaveLength(MAX_MESSAGE_CHARS)
    expect(projected.message.endsWith('…')).toBe(true)
  })

  it('keeps null and omits undefined', () => {
    const detail: ObservabilityDetail<'app.crash'> = { message: null, reason: undefined }
    expect(projectEvent('app.crash', detail)).toEqual({ message: null })
  })
})
