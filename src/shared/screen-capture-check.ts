/**
 * Screen-capture self-check planner.
 *
 * Two distinct passes:
 *   1. probe  — OS / ScreenCaptureKit / desktopCapturer only. Does not talk to a model.
 *   2. vision — capture a real frame and ask Local AI or the configured API whether it can see it.
 *
 * The second pass is never probe-only. Failover between local and API happens at most once.
 * This is a Settings / overlay self-check: the result stays on this machine and is never sent to a teammate.
 */

import type { ProviderId } from './providers'

export type ScreenCheckPass = 'probe' | 'vision'
export type VisionBackend = 'local' | 'api'

export interface VisionCheckContext {
  /** Weights + mmproj on disk (vision-capable local payload). */
  localWeightsReady: boolean
  /** Settings → Local AI master switch. */
  localEnabled: boolean
  /** Active non-local provider is configured and vision-capable (Dust uses the selected agent). */
  apiVisionReady: boolean
  activeProvider: ProviderId
}

export type ScreenCheckPlan =
  | { pass: 'probe' }
  | {
      pass: 'vision'
      primary: VisionBackend | null
      failover: VisionBackend | null
    }

export interface VisionReplyVerdict {
  sawShot: boolean
  preview: string
}

export const VISION_CHECK_PROMPT =
  'This is a Métis screen-capture self-check. Look at the attached screenshot. ' +
  'If you can see the image, reply with exactly one line: VISION_OK followed by 3-8 words naming something visible. ' +
  'If you cannot see any image, reply VISION_FAIL. Do not mention other people or send anything anywhere.'

export const VISION_CHECK_SYSTEM =
  'You verify that Métis can see a screenshot. Follow the user instruction exactly. ' +
  'This is a private self-check. Do not address a teammate or suggest sharing the result.'

/** First click is always the OS probe; every later click is a vision pass. */
export function nextScreenCheckPass(lastPass: ScreenCheckPass | null): ScreenCheckPass {
  return lastPass == null ? 'probe' : 'vision'
}

export function isApiVisionCandidate(provider: ProviderId, visionOk: boolean, configured: boolean): boolean {
  if (provider === 'local') return false
  return visionOk && configured
}

/**
 * Primary + at most one failover. Local-first when weights are present and the user is not on an API;
 * API-first when the active provider is a vision-capable API (Tony's "or API on a second time" is the
 * failover hop — and the vice-versa when he is already on API and Local AI is enabled).
 */
export function pickVisionBackends(ctx: VisionCheckContext): {
  primary: VisionBackend | null
  failover: VisionBackend | null
} {
  const localReady = ctx.localWeightsReady
  const onApi = ctx.activeProvider !== 'local' && ctx.apiVisionReady

  if (onApi) {
    return {
      primary: 'api',
      failover: ctx.localEnabled && localReady ? 'local' : null
    }
  }
  if (localReady) {
    return { primary: 'local', failover: ctx.apiVisionReady ? 'api' : null }
  }
  if (ctx.apiVisionReady) {
    return { primary: 'api', failover: null }
  }
  return { primary: null, failover: null }
}

export function planScreenCaptureCheck(pass: ScreenCheckPass, ctx: VisionCheckContext): ScreenCheckPlan {
  if (pass === 'probe') return { pass: 'probe' }
  const { primary, failover } = pickVisionBackends(ctx)
  return { pass: 'vision', primary, failover }
}

const REFUSAL =
  /VISION_FAIL\b|cannot see|can(?:not|'t)\s+see|no image|unable to (?:see|view)|i don'?t (?:see|have) (?:an? )?(?:image|screenshot)|no screenshot|nothing (?:is )?visible/i
const OK_TOKEN = /VISION_OK\b/i
const VISUAL =
  /screen|window|text|button|menu|browser|app|icon|bar|desktop|image|shows|visible|display|code|slide|doc|panel|tab|cursor|dock/i

export function interpretVisionReply(text: string): VisionReplyVerdict {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  const preview = trimmed.slice(0, 160)
  if (!trimmed) return { sawShot: false, preview: '' }
  if (OK_TOKEN.test(trimmed)) {
    const after = trimmed.replace(OK_TOKEN, '').replace(/^[ :.\-–—]+/, '').trim()
    if (after.length >= 2 && !REFUSAL.test(after)) return { sawShot: true, preview: after.slice(0, 160) }
    return { sawShot: false, preview }
  }
  if (REFUSAL.test(trimmed)) return { sawShot: false, preview }
  if (trimmed.length >= 16 && VISUAL.test(trimmed)) return { sawShot: true, preview }
  return { sawShot: false, preview }
}

export function formatProbeMessage(ok: boolean): string {
  return ok
    ? 'Screen capture works (OS probe). Check again so a model can see a real shot.'
    : 'Screen capture probe failed. Enable Screen Recording in System Settings → Privacy & Security, then restart Métis if you just granted it.'
}

export function formatVisionMessage(input: {
  ok: boolean
  backendLabel?: string
  failedOver?: boolean
  reason?: string
  noBackend?: boolean
}): string {
  if (input.noBackend) {
    return 'No vision-capable Local AI or API is ready. Open Settings → AI to enable Local AI (weights must be present) or connect a provider that can read images, including a vision-capable Dust agent.'
  }
  if (input.ok && input.backendLabel) {
    return input.failedOver
      ? `${input.backendLabel} can see the screen (after the other backend failed).`
      : `${input.backendLabel} can see the screen.`
  }
  const who = input.backendLabel ? ` (${input.backendLabel})` : ''
  const detail = input.reason ? ` ${input.reason}` : ''
  return `The model could not see the screenshot${who}.${detail}`.trim()
}
