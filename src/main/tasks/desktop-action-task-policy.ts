/**
 * Policy, limits and resource names for the desktop command path (split out of the task bridge in G40 so the bridge
 * stays under the file-size ratchet). The bridge re-exports everything here.
 */
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { DESKTOP_ADAPTER_IDS } from '@shared/desktop-actions'
import type { SchedulerLimits } from './task-scheduler'
import type { TaskPolicy } from './task-contract'

/** One confirmed desktop command is one task. The capability is the adapter id, so a grant cannot cross actions. */
export const DESKTOP_ACTION_TASK_TYPE = 'desktop-action'
export const ACTIONS_RESOURCE = 'actions'
const DAY_MS = 24 * 60 * 60 * 1000

/** Owner-chosen limits for the desktop command path. The task modules deliberately define none of their own. */
export const DESKTOP_ACTION_TASK_POLICY: TaskPolicy = {
  allowedTaskTypes: [DESKTOP_ACTION_TASK_TYPE],
  allowedCapabilities: DESKTOP_ADAPTER_IDS,
  resourceBudgets: { [ACTIONS_RESOURCE]: 1 },
  maxRetentionMs: DAY_MS,
  // A dispatch grant is issued after confirmation and used at once, so a grant that outlives 10 s is a bug, not a slow
  // user. The card's own lifetime (12 s, 30 s with assistive technology) is a different clock.
  maxGrantTtlMs: 10_000
}
export const GRANT_TTL_MS = 10_000

/**
 * Owner-approved 2026-10-22: one desktop-effect task per owner, four read-only, and a 10 s queue wait (no longer
 * than a confirmation lives), so a confirmed action never fires long after it was approved.
 */
export const DESKTOP_ACTION_SCHEDULER_LIMITS: SchedulerLimits = {
  maxEffectPerOwner: 1,
  maxReadOnlyPerOwner: 4,
  maxQueuedPerOwner: 8,
  maxQueueWaitMs: GRANT_TTL_MS
}

/**
 * The named resources an action touches, so two tasks never act on the same app or device at once. Every desktop
 * adapter launches or drives an app, so each is an effect job; the resource is the app it acts on.
 */
export function desktopActionResources(request: DesktopActionRequest): string[] {
  switch (request.id) {
    case 'desktop.open_notes':
    case 'desktop.create_note':
      return ['app:notes']
    case 'desktop.open_arc':
      return ['app:arc']
    case 'desktop.google_search':
    case 'desktop.open_x':
      return [request.args.browser === 'arc' ? 'app:arc' : 'app:default-browser']
    case 'desktop.photo_booth_capture':
      return ['app:photo-booth', 'device:camera']
  }
}
