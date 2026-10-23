import { describe, expect, it } from 'vitest'
import { MIN_MACOS, MIN_WINDOWS, evaluatePlatformSupport, unsupportedOsCopy } from './platform-support'

describe('platform support (D-26)', () => {
  it('declares macOS 14.4 as the minimum', () => {
    expect(MIN_MACOS).toMatchObject({ major: 14, minor: 4, label: '14.4' })
  })

  it.each([
    ['14.4', true],
    ['14.4.1', true],
    ['14.5', true],
    ['15.0', true],
    ['26.0.1', true],
    ['14.3.1', false],
    ['14.0', false],
    ['13.6.9', false],
    ['12.7', false]
  ])('macOS %s supported=%s', (version, supported) => {
    expect(evaluatePlatformSupport('darwin', version).supported).toBe(supported)
  })

  it.each([
    ['10.0.17763', true],
    ['10.0.19045', true],
    ['10.0.26100', true],
    ['10.0.17134', false],
    ['6.3.9600', false],
    ['6.1.7601', false]
  ])('Windows %s supported=%s', (version, supported) => {
    expect(evaluatePlatformSupport('win32', version).supported).toBe(supported)
  })

  it('never blocks other platforms or an unreadable version (fail open, not a guess)', () => {
    expect(evaluatePlatformSupport('linux', '6.8').supported).toBe(true)
    expect(evaluatePlatformSupport('darwin', '').supported).toBe(true)
    expect(evaluatePlatformSupport('darwin', 'unknown').supported).toBe(true)
    expect(evaluatePlatformSupport('win32', undefined).supported).toBe(true)
  })

  it('uses sentence-case copy that names the minimum', () => {
    expect(unsupportedOsCopy('darwin')).toBe('Métis needs macOS 14.4 or later.')
    expect(unsupportedOsCopy('win32')).toBe('Métis needs Windows 10 version 1809 or later.')
    expect(evaluatePlatformSupport('darwin', '13.0')).toEqual({
      supported: false,
      message: 'Métis needs macOS 14.4 or later.'
    })
    expect(MIN_WINDOWS.build).toBe(17763)
  })
})
