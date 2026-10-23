/**
 * Production composition of the task browser (G41). One manager per process. Stop, sign-out and lock reach it through
 * command-confirm-runtime's stopTasks; Settings reaches it through task-browser-ipc. The profile disclosure
 * acknowledgement is a flag file in userData; it holds no page data.
 */
import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { devEnv } from '../dev-env'
import { mainLog } from '../logger'
import { getSettings } from '../store'
import { createTaskBrowserSession, createTaskBrowserSurface } from '../windows/task-browser-window'
import { TaskBrowserManager, type TaskBrowserDisclosure } from './task-browser-manager'

function createDisclosureStore(file: () => string): TaskBrowserDisclosure {
  let cached: boolean | null = null
  return {
    async acknowledged() {
      if (cached === null) {
        try {
          cached = (await readFile(file(), 'utf8')).trim() === 'acknowledged'
        } catch {
          cached = false
        }
      }
      return cached
    },
    async acknowledge() {
      await mkdir(dirname(file()), { recursive: true })
      await atomicSavedWrite(file(), Buffer.from('acknowledged'))
      cached = true
    }
  }
}

let shared: TaskBrowserManager | null = null

export function taskBrowserRuntime(): TaskBrowserManager {
  shared ??= new TaskBrowserManager({
    createSurface: () => createTaskBrowserSurface(!devEnv('ASKTOTO_DISABLE_CP') && getSettings().contentProtection),
    session: createTaskBrowserSession(),
    disclosure: createDisclosureStore(() => join(app.getPath('userData'), 'task-browser-disclosure.txt')),
    observe: (receipt) => mainLog.info(`[task-browser] ${receipt.kind}`)
  })
  return shared
}

/** Stop, sign-out, lock and quit: close every task window. Safe before the runtime exists. */
export function releaseAllTaskBrowserWindows(): number {
  return shared?.releaseAll() ?? 0
}
