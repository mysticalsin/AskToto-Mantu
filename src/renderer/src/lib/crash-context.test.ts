import { describe, expect, it } from 'vitest'
import { crashReport, noteCrashContext } from './crash-context'

describe('renderer crash context', () => {
  it('uses safe default context before App first notes it and preserves message defaults', () => {
    const report = crashReport(null, undefined)

    expect(report.view).toBe('answer')
    expect(report.listening).toBe(false)
    expect(report.message).toBe('Unknown renderer error')
    expect(report.stack).toBeUndefined()
    expect(report.componentStack).toBeUndefined()
  })

  it('carries the last noted view and listening state', () => {
    noteCrashContext({ view: 'history', listening: true })

    expect(crashReport(new Error('render failed'), 'component stack')).toMatchObject({
      view: 'history',
      listening: true,
      message: 'render failed',
      componentStack: 'component stack'
    })
  })

  it('copies stack and componentStack when present', () => {
    const error = new Error('render failed')
    error.stack = 'stack trace'

    expect(crashReport(error, 'component stack')).toMatchObject({
      message: 'render failed',
      stack: 'stack trace',
      componentStack: 'component stack'
    })
  })
})
