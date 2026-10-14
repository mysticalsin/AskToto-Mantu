import { describe, expect, it } from 'vitest'
import { parseLeanCheckerArgs } from './lean-checker-args.mjs'

describe('unsigned lean package checker arguments', () => {
  it('requires a single concrete target architecture', () => {
    expect(parseLeanCheckerArgs(['mac', '/tmp/resources', '--arch=arm64'])).toEqual({
      target: 'mac', resourcesArg: '/tmp/resources', arch: 'arm64', executableName: 'Metis.exe', platform: 'darwin'
    })
    expect(() => parseLeanCheckerArgs(['mac', '/tmp/resources', '--arch=arm64', '--arch=x64'])).toThrow(/duplicate/)
  })

  it('rejects the former post-sign escape hatch and other unknown switches', () => {
    expect(() => parseLeanCheckerArgs(['mac', '/tmp/resources', '--arch=arm64', '--post-sign'])).toThrow(/Unknown or duplicate option/)
    expect(() => parseLeanCheckerArgs(['win', '/tmp/resources', '--arch=x64', '--skip-assets'])).toThrow(/Unknown or duplicate option/)
  })

  it('rejects universal and unsupported platform architecture combinations', () => {
    expect(() => parseLeanCheckerArgs(['mac', '/tmp/resources', '--arch=universal'])).toThrow(/Usage/)
    expect(() => parseLeanCheckerArgs(['win', '/tmp/resources', '--arch=arm64'])).toThrow(/x64 only/)
  })
})
