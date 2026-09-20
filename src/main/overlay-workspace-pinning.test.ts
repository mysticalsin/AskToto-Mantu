import { describe, expect, it, vi, type Mock } from 'vitest'
import { pinWindowOnAllWorkspaces } from './overlay-workspace-pinning'

type WorkspacePin = (visible: boolean, options: { visibleOnFullScreen: boolean }) => void

function fakeWindow(): { setVisibleOnAllWorkspaces: Mock<WorkspacePin> } {
  return { setVisibleOnAllWorkspaces: vi.fn<WorkspacePin>() }
}

describe('pinWindowOnAllWorkspaces', () => {
  it('pins each macOS window once even when its overlay state is reapplied', () => {
    const overlay = fakeWindow()

    pinWindowOnAllWorkspaces(overlay, 'darwin')
    pinWindowOnAllWorkspaces(overlay, 'darwin')

    expect(overlay.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1)
    expect(overlay.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true })
  })

  it('pins a replacement window independently', () => {
    const first = fakeWindow()
    const replacement = fakeWindow()

    pinWindowOnAllWorkspaces(first, 'darwin')
    pinWindowOnAllWorkspaces(replacement, 'darwin')

    expect(first.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1)
    expect(replacement.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('does not apply a macOS workspace transition on Windows', () => {
    const overlay = fakeWindow()

    pinWindowOnAllWorkspaces(overlay, 'win32')

    expect(overlay.setVisibleOnAllWorkspaces).not.toHaveBeenCalled()
  })
})
