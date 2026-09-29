// Minimal Electron main process for the design-capture job: one sandboxed window, no preload and no app
// code, showing the built QA-only renderer entry. The driver (capture-states.mjs) launches this file with
// METIS_DESIGN_CAPTURE_URL set and navigates the window per state.
const { app, BrowserWindow } = require('electron')

const WIDTH = 960
const HEIGHT = 640

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    resizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  void win.loadURL(process.env.METIS_DESIGN_CAPTURE_URL)
})

app.on('window-all-closed', () => app.quit())
