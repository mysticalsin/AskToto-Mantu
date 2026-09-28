import { describe, expect, it } from 'vitest'
import {
  UI_DEPENDENCY_REVIEW,
  assertQualificationInputs,
  collectLockfilePins
} from './qualify-ui-deps.mjs'

const packageJson = {
  devDependencies: {
    'thinking-orbs': '0.3.1'
  }
}

const packageLock = {
  packages: {
    '': {
      devDependencies: {
        'thinking-orbs': '0.3.1'
      }
    },
    'node_modules/thinking-orbs': {
      version: '0.3.1',
      license: 'MIT'
    }
  }
}

describe('M2-0092 UI dependency qualification', () => {
  it('accepts the adopted renderer dependency only when the package and lockfile are exact-pinned', () => {
    const pins = assertQualificationInputs(packageJson, packageLock)

    expect(pins).toContainEqual({
      packageName: 'thinking-orbs',
      expectedVersion: '0.3.1',
      packageJsonRange: '0.3.1',
      lockfileVersion: '0.3.1',
      lockfileLicense: 'MIT',
      adopted: true
    })
  })

  it('rejects range pins for the adopted dependency', () => {
    expect(() =>
      assertQualificationInputs(
        { devDependencies: { 'thinking-orbs': '^0.3.1' } },
        {
          packages: {
            '': { devDependencies: { 'thinking-orbs': '^0.3.1' } },
            'node_modules/thinking-orbs': { version: '0.3.1', license: 'MIT' }
          }
        }
      )
    ).toThrow('thinking-orbs must be exact-pinned to 0.3.1 in package.json')
  })

  it('keeps unadopted candidates out of the lockfile until adoption is explicitly decided', () => {
    expect(() =>
      assertQualificationInputs(
        { devDependencies: { 'thinking-orbs': '0.3.1', 'border-beam': '1.4.1' } },
        {
          packages: {
            '': { devDependencies: { 'thinking-orbs': '0.3.1', 'border-beam': '1.4.1' } },
            'node_modules/thinking-orbs': { version: '0.3.1', license: 'MIT' },
            'node_modules/border-beam': { version: '1.4.1', license: 'MIT' }
          }
        }
      )
    ).toThrow('border-beam is not adopted')
  })

  it('records native-port reconciliation for every candidate', () => {
    expect(UI_DEPENDENCY_REVIEW.map((candidate) => [candidate.packageName, candidate.nativePort])).toEqual([
      ['thinking-orbs', 'none'],
      ['border-beam', 'not-adopted'],
      ['voice-glow', 'none']
    ])
  })

  it('reports absent unadopted candidates as pinned review candidates, not lockfile dependencies', () => {
    expect(collectLockfilePins(packageJson, packageLock)).toEqual([
      {
        packageName: 'thinking-orbs',
        expectedVersion: '0.3.1',
        packageJsonRange: '0.3.1',
        lockfileVersion: '0.3.1',
        lockfileLicense: 'MIT',
        adopted: true
      },
      {
        packageName: 'border-beam',
        expectedVersion: '1.4.1',
        packageJsonRange: null,
        lockfileVersion: null,
        lockfileLicense: null,
        adopted: false
      },
      {
        packageName: 'voice-glow',
        expectedVersion: '0.2.0',
        packageJsonRange: null,
        lockfileVersion: null,
        lockfileLicense: null,
        adopted: false
      }
    ])
  })
})
