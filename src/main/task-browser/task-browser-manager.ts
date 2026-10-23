/**
 * Task browser manager (G41): one Métis-owned browser window per task, its lifecycle and its guards.
 *
 * It never touches Electron: a `TaskBrowserSurface` is the thin window the production adapter provides. That keeps the
 * rules testable: https only, a blocked address never loads, a new window opens in the same window or is refused, a
 * window lives for its task and is released when the task ends or the owner stops it. Nothing here reaches the
 * person's own browser (D-21); `openCurrentTab` only says why not.
 */
import {
  CURRENT_TAB_CAPABILITY,
  MAX_TASK_BROWSER_WINDOWS,
  type TaskBrowserReceipt,
  type TaskBrowserStatus
} from '@shared/task-browser'
import { allowedTaskBrowserUrl, taskBrowserUrlFingerprint } from './task-browser-policy'

/** The window as the manager sees it. Every callback is registered once, before the first load. */
export interface TaskBrowserSurface {
  load(url: string): Promise<void>
  /** Return false to cancel the navigation (will-navigate and will-redirect). */
  onNavigate(allow: (url: string) => boolean): void
  /** A page asked for a new window. The surface always refuses it and reports the address here. */
  onNewWindow(request: (url: string) => void): void
  onLoadFinished(listener: (url: string) => void): void
  onLoadFailed(listener: (url: string) => void): void
  /** The person closed the window. */
  onClosed(listener: () => void): void
  close(): void
}

export interface TaskBrowserSession {
  /** Remove cookies, storage and cache of the task profile only. */
  clear(): Promise<void>
}

export interface TaskBrowserDisclosure {
  acknowledged(): Promise<boolean>
  acknowledge(): Promise<void>
}

export interface TaskBrowserManagerDeps {
  createSurface(): TaskBrowserSurface
  session: TaskBrowserSession
  disclosure: TaskBrowserDisclosure
  /** G42's seam: receipts bound to the task. A throwing observer never breaks the window. */
  observe?: (receipt: TaskBrowserReceipt) => void
}

export type TaskBrowserOpenResult =
  | { readonly ok: true; readonly reused: boolean }
  | {
      readonly ok: false
      readonly reason: 'disclosure_required' | 'blocked_url' | 'too_many_windows' | 'invalid_task' | 'load_failed'
    }

export class TaskBrowserManager {
  private readonly windows = new Map<string, TaskBrowserSurface>()

  constructor(private readonly deps: TaskBrowserManagerDeps) {}

  /** Open (or reuse) the task's window and load an https address. The first use needs the profile disclosure. */
  async open(taskId: string, rawUrl: string): Promise<TaskBrowserOpenResult> {
    if (typeof taskId !== 'string' || taskId.length === 0) return { ok: false, reason: 'invalid_task' }
    if (!(await this.deps.disclosure.acknowledged())) return { ok: false, reason: 'disclosure_required' }
    const url = allowedTaskBrowserUrl(rawUrl)
    if (!url) {
      this.emit({ kind: 'navigation_blocked', taskId, origin: 'blocked', urlHash: '00000000' })
      return { ok: false, reason: 'blocked_url' }
    }
    let surface = this.windows.get(taskId)
    const reused = surface !== undefined
    if (!surface) {
      if (this.windows.size >= MAX_TASK_BROWSER_WINDOWS) return { ok: false, reason: 'too_many_windows' }
      surface = this.deps.createSurface()
      this.windows.set(taskId, surface)
      this.wire(taskId, surface)
      this.emit({ kind: 'opened', taskId })
    }
    this.emit({ kind: 'navigation_started', taskId, ...taskBrowserUrlFingerprint(url) })
    try {
      await surface.load(url.href)
    } catch {
      // The load failure is reported by the surface's own event; the window stays for the task.
      return { ok: false, reason: 'load_failed' }
    }
    return { ok: true, reused }
  }

  /** The task ended: close its window and drop its state. */
  release(taskId: string): boolean {
    const surface = this.windows.get(taskId)
    if (!surface) return false
    this.windows.delete(taskId)
    this.closeQuietly(surface)
    this.emit({ kind: 'released', taskId })
    return true
  }

  /** Stop, sign-out, lock or quit: every task window goes. Returns how many closed. */
  releaseAll(): number {
    let closed = 0
    for (const taskId of [...this.windows.keys()]) if (this.release(taskId)) closed += 1
    return closed
  }

  acknowledgeDisclosure(): Promise<void> {
    return this.deps.disclosure.acknowledge()
  }

  hasWindow(taskId: string): boolean {
    return this.windows.has(taskId)
  }

  /** Clears the task profile only (never the app's session). Windows close first so nothing writes it back. */
  async clearProfile(): Promise<boolean> {
    this.releaseAll()
    try {
      await this.deps.session.clear()
      return true
    } catch {
      return false
    }
  }

  /** D-21: using the person's own tab is not available. This never reaches a real browser. */
  openCurrentTab(): { readonly ok: false; readonly reason: 'current_tab_unavailable'; readonly copy: string } {
    return { ok: false, reason: 'current_tab_unavailable', copy: CURRENT_TAB_CAPABILITY.copy }
  }

  async status(): Promise<TaskBrowserStatus> {
    return {
      disclosureAcknowledged: await this.deps.disclosure.acknowledged(),
      openWindows: this.windows.size,
      currentTab: { status: CURRENT_TAB_CAPABILITY.status, copy: CURRENT_TAB_CAPABILITY.copy }
    }
  }

  private wire(taskId: string, surface: TaskBrowserSurface): void {
    const fingerprint = (raw: string): { origin: string; urlHash: string } => {
      const parsed = allowedTaskBrowserUrl(raw)
      return parsed ? taskBrowserUrlFingerprint(parsed) : { origin: 'blocked', urlHash: '00000000' }
    }
    surface.onNavigate((raw) => {
      const url = allowedTaskBrowserUrl(raw)
      if (!url) {
        this.emit({ kind: 'navigation_blocked', taskId, ...fingerprint(raw) })
        return false
      }
      this.emit({ kind: 'navigation_started', taskId, ...taskBrowserUrlFingerprint(url) })
      return true
    })
    // A page that asks for a new window gets the same window if the address is allowed, and nothing otherwise.
    surface.onNewWindow((raw) => {
      const url = allowedTaskBrowserUrl(raw)
      if (!url || this.windows.get(taskId) !== surface) {
        this.emit({ kind: 'navigation_blocked', taskId, ...fingerprint(raw) })
        return
      }
      this.emit({ kind: 'navigation_started', taskId, ...taskBrowserUrlFingerprint(url) })
      void surface.load(url.href).catch(() => undefined)
    })
    surface.onLoadFinished((raw) => this.emit({ kind: 'load_finished', taskId, ...fingerprint(raw) }))
    surface.onLoadFailed((raw) => this.emit({ kind: 'load_failed', taskId, ...fingerprint(raw) }))
    surface.onClosed(() => {
      if (this.windows.get(taskId) !== surface) return
      this.windows.delete(taskId)
      this.emit({ kind: 'closed_by_person', taskId })
    })
  }

  private closeQuietly(surface: TaskBrowserSurface): void {
    try {
      surface.close()
    } catch {
      /* already gone */
    }
  }

  private emit(receipt: TaskBrowserReceipt): void {
    try {
      this.deps.observe?.(receipt)
    } catch {
      /* an observer must never break the window */
    }
  }
}
