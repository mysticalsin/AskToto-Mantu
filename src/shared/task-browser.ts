/**
 * Task browser (Métis 2.12 G41, D-21): the contract between main, the preload bridge and Settings for the one browser
 * window Métis owns for a task. Pure data and words, no Electron.
 *
 * Only a Métis-owned window with its own profile exists in 2.12. Using the person's own browser tab waits until an
 * explicit selection is qualified, so that capability is typed here as `unavailable` and nothing wires it.
 */
import { z } from 'zod'

export const TASK_BROWSER_IPC = {
  status: 'taskBrowser:status',
  acknowledge: 'taskBrowser:acknowledge',
  clear: 'taskBrowser:clear'
} as const

/** The persistent Electron session partition of the task window. Never the app's own session. */
export const TASK_BROWSER_PARTITION = 'persist:metis-task-browser'

/** The window title. A page can never change it, so the person always knows whose window this is. */
export const TASK_BROWSER_WINDOW_TITLE = 'Métis task browser'

/** At most this many task windows exist at once (one per task). */
export const MAX_TASK_BROWSER_WINDOWS = 4

export const CURRENT_TAB_UNAVAILABLE_COPY = "Using your current browser tab isn't available yet."

/** D-21: using the person's own tab is not implemented. This is the whole capability, and it is never wired. */
export const CURRENT_TAB_CAPABILITY = {
  id: 'browser.current_tab',
  status: 'unavailable',
  copy: CURRENT_TAB_UNAVAILABLE_COPY
} as const

/** Every word the person reads about the task browser, in one place so the copy is reviewed together. */
export const TASK_BROWSER_COPY = {
  title: 'Task browser',
  desc: 'When Métis needs a web page for a task, it opens its own browser window. That window is separate from your browser.',
  disclosure:
    "Métis uses its own browser profile for tasks. It has its own cookies and sign-ins, separate from your browser, so you may need to sign in to a site once. It is stored in Métis's app data folder on this computer. You can clear it here at any time.",
  acknowledge: 'Understood',
  clearButton: 'Clear task browser data',
  clearConfirm: 'Clear cookies, sign-ins and site data from the task browser? Your own browser is not touched.',
  clearConfirmButton: 'Clear',
  clearCancel: 'Keep',
  cleared: 'Task browser data cleared.',
  clearFailed: "Couldn't clear the task browser data. Try again.",
  currentTab: CURRENT_TAB_UNAVAILABLE_COPY
} as const

export const TaskBrowserStatusSchema = z
  .object({
    disclosureAcknowledged: z.boolean(),
    openWindows: z.number().int().min(0).max(MAX_TASK_BROWSER_WINDOWS),
    currentTab: z.object({ status: z.literal('unavailable'), copy: z.string() })
  })
  .strict()
export type TaskBrowserStatus = z.infer<typeof TaskBrowserStatusSchema>

export const TaskBrowserOkSchema = z.object({ ok: z.boolean() }).strict()
export type TaskBrowserOk = z.infer<typeof TaskBrowserOkSchema>

/**
 * What G42 reads. Every receipt is bound to the task that owns the window and carries an origin and a hash of the full
 * URL, never the URL, page title or page text: a page is data, and its address can carry private details.
 */
export type TaskBrowserReceipt =
  | {
      readonly kind: 'opened' | 'released' | 'closed_by_person'
      readonly taskId: string
    }
  | {
      readonly kind: 'navigation_started' | 'load_finished' | 'load_failed' | 'navigation_blocked'
      readonly taskId: string
      readonly origin: string
      readonly urlHash: string
    }
