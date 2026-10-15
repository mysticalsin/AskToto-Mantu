import { describe, expect, it, vi } from 'vitest'
import {
  isCurrentCloudSttSender,
  shouldClearCloudSttIpcOwner,
  shouldInvalidateCloudSttOwner
} from './cloud-stt-window-owner'

describe('cloud speech owner window identity', () => {
  it('invalidates the closing current window from cached identity without reading destroyed getters', () => {
    const contents = { isDestroyed: vi.fn(() => true), id: 7 }
    const window = {
      isDestroyed: () => true,
      get webContents() {
        throw new Error('destroyed webContents getter')
      }
    } as unknown as { isDestroyed(): boolean; webContents: typeof contents }
    const owner = { window, webContents: contents, webContentsId: 7 }

    expect(shouldInvalidateCloudSttOwner(window, null, owner)).toBe(true)
    expect(isCurrentCloudSttSender(window, 7, contents)).toBe(false)
    expect(contents.isDestroyed).not.toHaveBeenCalled()
  })

  it('invalidates an accepted closing owner but never invalidates a replacement renderer', () => {
    const closingContents = { isDestroyed: () => true, id: 7 }
    const closingWindow = { isDestroyed: () => true, webContents: closingContents }
    const owner = { window: closingWindow, webContents: closingContents, webContentsId: 7 }
    const replacementContents = { isDestroyed: () => false, id: 8 }
    const replacementWindow = { isDestroyed: () => false, webContents: replacementContents }

    expect(shouldInvalidateCloudSttOwner(replacementWindow, closingContents, owner)).toBe(true)
    expect(shouldInvalidateCloudSttOwner(replacementWindow, replacementContents, owner)).toBe(false)
    expect(shouldClearCloudSttIpcOwner(7, owner)).toBe(true)
    expect(shouldClearCloudSttIpcOwner(8, owner)).toBe(false)
    expect(shouldClearCloudSttIpcOwner(8)).toBe(true)
    expect(isCurrentCloudSttSender(replacementWindow, 7, closingContents)).toBe(false)
    expect(shouldInvalidateCloudSttOwner(replacementWindow, null)).toBe(true)
  })
})
