type DenialReason = 'no_window' | 'sender' | 'frame'
type MainWindow = Electron.BrowserWindow
type MainWindowEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent

/** Keep the top-frame principal check shared by invoke and one-way IPC handlers. */
export function createMainWindowSenderAuthority(
  getWindow: () => MainWindow | null,
  noteDenied: (reason: DenialReason) => void
): {
  assertMainWindow(event: MainWindowEvent): void
  isMainWindowSender(event: Electron.IpcMainEvent): boolean
} {
  const denial = (event: MainWindowEvent): DenialReason | null => {
    const win = getWindow()
    if (!win || win.isDestroyed()) {
      noteDenied('no_window')
      return 'no_window'
    }
    if (event.sender !== win.webContents) {
      noteDenied('sender')
      return 'sender'
    }
    const frame = event.senderFrame
    if (!frame || frame.parent !== null || frame.url !== win.webContents.getURL()) {
      noteDenied('frame')
      return 'frame'
    }
    return null
  }
  return {
    assertMainWindow(event: MainWindowEvent): void {
      const denied = denial(event)
      if (denied === 'no_window') throw new Error('Main window not available')
      if (denied === 'sender') throw new Error('IPC denied: sender is not the main window')
      if (denied === 'frame') throw new Error('IPC denied: not main frame')
    },
    isMainWindowSender(event: Electron.IpcMainEvent): boolean {
      return denial(event) === null
    }
  }
}
