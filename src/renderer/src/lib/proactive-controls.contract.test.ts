import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const IMPORT_OF_CONTROLS = /from\s+['"][^'"]*proactive-controls['"]/

describe('proactive controls contract (G77)', () => {
  it('direct ask and quiet-release paths do not import proactive-controls', () => {
    for (const specifier of ['./ask-start', './ask-context', './ask-types', './quiet-release', '../state']) {
      const { text } = readModuleSource(__dirname, specifier)
      expect(IMPORT_OF_CONTROLS.test(text), specifier).toBe(false)
    }
  })

  it('only the question flow and its hook import proactive-controls', () => {
    expect(IMPORT_OF_CONTROLS.test(readModuleSource(__dirname, './intervention-flow').text)).toBe(true)
    expect(IMPORT_OF_CONTROLS.test(readModuleSource(__dirname, './use-intervention-wiring').text)).toBe(true)
  })

  it('shadow pre-generation is not subject to the question controls', () => {
    const { text } = readModuleSource(__dirname, './intervention-flow')
    const shadow = text.slice(text.indexOf('export async function runShadowFlow'))
    expect(shadow.includes('controls')).toBe(false)
  })

  it('App.tsx, index.ts, ipc.ts, preload/index.ts line counts are not above the G70 tip baseline', () => {
    const baseline: Array<[string, number]> = [
      ['../App', 4571],
      ['../../../main/index', 9772],
      ['../../../shared/ipc', 2181],
      ['../../../preload/index', 795]
    ]
    for (const [specifier, max] of baseline) {
      const { text } = readModuleSource(__dirname, specifier)
      expect(text.split('\n').length - 1, specifier).toBeLessThanOrEqual(max)
    }
  })

  it('never logs trigger text or the playbook fingerprint', () => {
    for (const specifier of ['./proactive-controls', './intervention-flow']) {
      const { text } = readModuleSource(__dirname, specifier)
      expect(/console\.|report\(/.test(text), specifier).toBe(false)
    }
  })
})
