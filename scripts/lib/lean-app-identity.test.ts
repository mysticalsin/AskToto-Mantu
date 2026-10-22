import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { leanAppIdentity } from './lean-app-identity.mjs'

describe('lean package app identity (G11)', () => {
  it('is the established Metis identity by default', () => {
    expect(leanAppIdentity({})).toEqual({ bundleIdentifier: 'com.mantu.asktoto', executableName: 'Metis' })
  })

  it('is the QA identity only when the build was compiled as the QA identity', () => {
    expect(leanAppIdentity({ METIS_QA_IDENTITY: '1' })).toEqual({
      bundleIdentifier: 'com.mantu.asktoto.qa',
      executableName: 'Metis QA'
    })
    for (const value of ['0', 'true', '', ' 1']) {
      expect(leanAppIdentity({ METIS_QA_IDENTITY: value }).bundleIdentifier).toBe('com.mantu.asktoto')
    }
  })

  it('is what the lean package checker enforces, instead of a hard-coded identity', () => {
    const checker = readFileSync(join(__dirname, '..', 'check-lean-package.mjs'), 'utf8')
    expect(checker).toMatch(/from '\.\/lib\/lean-app-identity\.mjs'/)
    expect(checker).not.toMatch(/bundleIdentifier !== 'com\.mantu\.asktoto'/)
    expect(checker).not.toMatch(/'MacOS', 'Metis'\)/)
  })
})
