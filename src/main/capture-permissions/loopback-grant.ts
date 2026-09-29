/**
 * loopback-grant.ts — the screen-source half of the display-media handler (M2-0429).
 *
 * macOS binds system-audio loopback to a ScreenCaptureKit screen stream, so meeting audio needs a screen
 * source. When the diagnosis already knows macOS will refuse (denied, restricted, a grant held by another
 * build, a grant waiting for a relaunch), asking anyway only cost ~750 ms of retries and produced a false
 * app.crash from Electron's internal "Failed to get sources." rejection. So: deny immediately with
 * capture.failed { reason: 'screen_permission_denied' } and never call getSources. The one non-granted state
 * that still asks is 'not-asked', because that first attempt is what makes macOS show its prompt.
 */
import type { ScreenDiagnosis } from '@shared/screen-permission'
import { getScreenSourcesWithRetry } from '../screen-capture'
import { screenCaptureMayProceed } from './diagnose'

export interface LoopbackScreenSourceDeps<S> {
  platform: NodeJS.Platform | string
  diagnose: () => ScreenDiagnosis
  getSources: () => Promise<S[]>
  isUsable: (source: S) => boolean
  noteAttempt: () => void
  noteOutcome: (succeeded: boolean) => void
  audit: (event: 'capture.failed', data: Record<string, unknown>) => void
  log: (message: string) => void
  wait?: (ms: number) => Promise<void>
}

/** The screen source to bind loopback audio to, or null to deny. Never rejects. */
export async function acquireLoopbackScreenSource<S>(deps: LoopbackScreenSourceDeps<S>): Promise<S | null> {
  if (deps.platform === 'darwin') {
    const diagnosis = deps.diagnose()
    if (!screenCaptureMayProceed(diagnosis)) {
      deps.audit('capture.failed', { reason: 'screen_permission_denied', phase: 'listen', state: diagnosis.state })
      return null
    }
    deps.noteAttempt()
  }
  const sources = await getScreenSourcesWithRetry(deps.getSources, deps.isUsable, {
    wait: deps.wait,
    onError: (error, attempt) =>
      deps.log(`[display-media] getSources failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`)
  })
  deps.noteOutcome(sources.length > 0)
  if (!sources.length) deps.audit('capture.failed', { reason: 'loopback_no_screen_source', phase: 'listen' })
  return sources[0] ?? null
}

/**
 * Electron's desktopCapturer can surface a denied macOS capture a second time, as a bare string rejection
 * "Failed to get sources." that no caller owns, even though the caller's own promise was caught. That is a
 * refused capture (already audited as capture.failed), not a crash, so the fatal handler must not record it
 * as app.crash.
 */
export function isOrphanScreenSourcesRejection(reason: unknown, platform: NodeJS.Platform | string): boolean {
  if (platform !== 'darwin') return false
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return message.trim() === 'Failed to get sources.'
}
