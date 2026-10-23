/**
 * The Electron side of the task browser (G41): the one place a BrowserWindow and the task session are touched.
 * Every rule lives in task-browser-policy.ts and task-browser-manager.ts; this file only maps events.
 */
import { BrowserWindow, session as electronSession } from 'electron'
import { TASK_BROWSER_PARTITION } from '@shared/task-browser'
import { devToolsEnabled } from '../dev-env'
import type { TaskBrowserSession, TaskBrowserSurface } from '../task-browser/task-browser-manager'
import {
  applyTaskBrowserSessionPolicy,
  taskBrowserWebPreferences,
  type TaskBrowserSessionLike
} from '../task-browser/task-browser-policy'

/** The task profile's session. A different object from the default session the app itself uses. */
export function taskBrowserElectronSession(): Electron.Session {
  return electronSession.fromPartition(TASK_BROWSER_PARTITION)
}

export function createTaskBrowserSession(): TaskBrowserSession {
  return {
    async clear() {
      const s = taskBrowserElectronSession()
      await s.clearStorageData()
      await s.clearCache()
      await s.clearAuthCache()
    }
  }
}

export function createTaskBrowserSurface(contentProtection: boolean): TaskBrowserSurface {
  const taskSession = taskBrowserElectronSession()
  applyTaskBrowserSessionPolicy(taskSession as unknown as TaskBrowserSessionLike)
  // The page gets no bridge to Métis (the window has no script injected before it loads). The window is an ordinary, titled, user-closable window.
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    // Must equal TASK_BROWSER_WINDOW_TITLE (held by a test); a literal so the window-title audit can read it.
    title: 'Métis task browser',
    show: true,
    webPreferences: taskBrowserWebPreferences(devToolsEnabled())
  })
  // Hide from screen capture: the one setting every Métis window follows (R038).
  win.setContentProtection(contentProtection)
  const contents = win.webContents
  // A page may not retitle the window: it always says whose window it is.
  win.on('page-title-updated', (event) => event.preventDefault())
  let allow: (url: string) => boolean = () => false
  let newWindow: (url: string) => void = () => undefined
  contents.on('will-navigate', (event, url) => {
    if (!allow(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!allow(url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    newWindow(url)
    return { action: 'deny' }
  })
  return {
    load: (url) => contents.loadURL(url),
    onNavigate(fn) {
      allow = fn
    },
    onNewWindow(fn) {
      newWindow = fn
    },
    onLoadFinished: (fn) => contents.on('did-finish-load', () => fn(contents.getURL())),
    onLoadFailed: (fn) => contents.on('did-fail-load', (_e, _code, _desc, url, isMainFrame) => isMainFrame && fn(url)),
    onClosed: (fn) => win.on('closed', fn),
    close() {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
