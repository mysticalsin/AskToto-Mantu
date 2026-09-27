import { describe, expect, it, vi } from 'vitest'
import { showRenderLoopHaltedDialog } from './render-loop-halted-dialog'

/** Resolves with whichever button label the message box was actually asked to show. */
function respondingWith(label: string) {
  return vi.fn(async (opts: Electron.MessageBoxOptions) => ({
    response: (opts.buttons ?? []).indexOf(label),
    checkboxChecked: false
  }))
}

function baseActions() {
  return { reload: vi.fn(), quit: vi.fn(), copyDiagnostics: vi.fn() }
}

describe('showRenderLoopHaltedDialog', () => {
  it('Reload calls actions.reload() and prompts only once', async () => {
    const showMessageBox = respondingWith('Reload')
    const actions = baseActions()

    await showRenderLoopHaltedDialog('crashed', 1, () => false, showMessageBox, actions)

    expect(actions.reload).toHaveBeenCalledTimes(1)
    expect(actions.quit).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('Quit calls actions.quit() and prompts only once', async () => {
    const showMessageBox = respondingWith('Quit')
    const actions = baseActions()

    await showRenderLoopHaltedDialog('crashed', 1, () => false, showMessageBox, actions)

    expect(actions.quit).toHaveBeenCalledTimes(1)
    expect(actions.reload).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it("'Open meetings folder' opens the folder, then re-prompts so Reload/Quit are still reachable", async () => {
    const responses = ['Open meetings folder', 'Reload']
    let call = 0
    const showMessageBox = vi.fn(async (opts: Electron.MessageBoxOptions) => ({
      response: (opts.buttons ?? []).indexOf(responses[call++]),
      checkboxChecked: false
    }))
    const openMeetingsFolder = vi.fn(async () => {})
    const actions = { ...baseActions(), openMeetingsFolder }

    await showRenderLoopHaltedDialog('crashed', 1, () => false, showMessageBox, actions)

    expect(openMeetingsFolder).toHaveBeenCalledTimes(1)
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(actions.reload).toHaveBeenCalledTimes(1)
  })

  it("'Copy diagnostics' copies, then re-prompts so Reload/Quit are still reachable", async () => {
    const responses = ['Copy diagnostics', 'Quit']
    let call = 0
    const showMessageBox = vi.fn(async (opts: Electron.MessageBoxOptions) => ({
      response: (opts.buttons ?? []).indexOf(responses[call++]),
      checkboxChecked: false
    }))
    const actions = baseActions()

    await showRenderLoopHaltedDialog('crashed', 1, () => false, showMessageBox, actions)

    expect(actions.copyDiagnostics).toHaveBeenCalledTimes(1)
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(actions.quit).toHaveBeenCalledTimes(1)
  })

  it("omits the 'Open meetings folder' button when the action is not supplied", async () => {
    const showMessageBox = respondingWith('Reload')
    const actions = baseActions() // no openMeetingsFolder — e.g. requireAuth() refused it

    await showRenderLoopHaltedDialog('crashed', 1, () => false, showMessageBox, actions)

    const opts = showMessageBox.mock.calls[0][0]
    expect(opts.buttons).toEqual(['Reload', 'Quit', 'Copy diagnostics'])
  })

  it('does nothing when the target is already gone before the first prompt', async () => {
    const showMessageBox = respondingWith('Reload')
    const actions = baseActions()

    await showRenderLoopHaltedDialog('crashed', 1, () => true, showMessageBox, actions)

    expect(showMessageBox).not.toHaveBeenCalled()
    expect(actions.reload).not.toHaveBeenCalled()
  })

  it('a target destroyed or replaced while the dialog was on screen does nothing after the await', async () => {
    let gone = false
    const showMessageBox = vi.fn(async (opts: Electron.MessageBoxOptions) => {
      // The window closed (or was replaced by a successor) while the user was looking at the dialog.
      gone = true
      return { response: (opts.buttons ?? []).indexOf('Reload'), checkboxChecked: false }
    })
    const actions = baseActions()

    await showRenderLoopHaltedDialog('crashed', 1, () => gone, showMessageBox, actions)

    expect(actions.reload).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledTimes(1) // no re-prompt for an already-gone target either
  })

  it('a target that goes away during "Open meetings folder" does not re-prompt', async () => {
    let gone = false
    const showMessageBox = respondingWith('Open meetings folder')
    const openMeetingsFolder = vi.fn(async () => {
      gone = true // e.g. the window was closed while the folder was opening
    })
    const actions = { ...baseActions(), openMeetingsFolder }

    await showRenderLoopHaltedDialog('crashed', 1, () => gone, showMessageBox, actions)

    expect(openMeetingsFolder).toHaveBeenCalledTimes(1)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(actions.reload).not.toHaveBeenCalled()
  })

  it('passes reason and exit code through into the dialog detail text', async () => {
    const showMessageBox = respondingWith('Quit')
    const actions = baseActions()

    await showRenderLoopHaltedDialog('oom', 137, () => false, showMessageBox, actions)

    const opts = showMessageBox.mock.calls[0][0]
    expect(opts.detail).toContain('oom')
    expect(opts.detail).toContain('137')
  })
})
