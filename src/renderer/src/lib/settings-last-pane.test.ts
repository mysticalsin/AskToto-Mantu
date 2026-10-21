import { describe, expect, it } from 'vitest'
import { readLastSettingsPane, writeLastSettingsPane } from './settings-last-pane'

const PANES = ['personalize', 'ai', 'meetings'] as const

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

describe('Settings restores the most recently viewed pane (HIG Settings)', () => {
  it('reads back the pane written last', () => {
    const storage = memoryStorage()
    expect(readLastSettingsPane(PANES, storage)).toBeNull()
    writeLastSettingsPane('meetings', storage)
    expect(readLastSettingsPane(PANES, storage)).toBe('meetings')
    writeLastSettingsPane('ai', storage)
    expect(readLastSettingsPane(PANES, storage)).toBe('ai')
  })

  it('ignores a pane that no longer exists', () => {
    const storage = memoryStorage()
    writeLastSettingsPane('notifications', storage)
    expect(readLastSettingsPane(PANES, storage)).toBeNull()
  })

  it('tolerates unavailable or throwing storage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(() => writeLastSettingsPane('ai', throwing)).not.toThrow()
    expect(readLastSettingsPane(PANES, throwing)).toBeNull()
    expect(readLastSettingsPane(PANES, null)).toBeNull()
  })
})
