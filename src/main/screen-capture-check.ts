/**
 * Screen-capture self-check runner.
 *
 * Probe pass: OS capture only (probeScreenCapture / desktopCapturer).
 * Vision pass: real frame + Local AI or the configured API, with at most one failover.
 * Never routes through askStart (overlay chat) and never pushes to a teammate / CRM.
 */

import {
  formatProbeMessage,
  formatVisionMessage,
  interpretVisionReply,
  planScreenCaptureCheck,
  type ScreenCheckPass,
  type VisionBackend,
  type VisionCheckContext
} from '@shared/screen-capture-check'

export interface ScreenCaptureCheckResult {
  ok: boolean
  pass: ScreenCheckPass
  backend?: 'probe' | VisionBackend
  backendLabel?: string
  failedOver?: boolean
  message: string
  preview?: string
}

export interface VisionAskResult {
  text: string
  label: string
}

export interface ScreenCaptureCheckDeps {
  probe: () => Promise<boolean>
  capture: () => Promise<{ image: string }>
  askVision: (backend: VisionBackend, image: string) => Promise<VisionAskResult>
  context: VisionCheckContext
}

/** Collect a one-shot vision stream. Isolated from askStart — nothing is painted on the overlay. */
export function collectVisionStream(
  start: (handlers: {
    onDelta: (text: string) => void
    onDone: () => void
    onError: (message: string) => void
  }) => { abort: () => void }
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    start({
      onDelta: (chunk) => {
        text += chunk
      },
      onDone: () => resolve(text.trim()),
      onError: (message) => reject(new Error(message))
    })
  })
}

export async function runScreenCaptureCheck(
  pass: ScreenCheckPass,
  deps: ScreenCaptureCheckDeps
): Promise<ScreenCaptureCheckResult> {
  const plan = planScreenCaptureCheck(pass, deps.context)

  if (plan.pass === 'probe') {
    const ok = await deps.probe()
    return {
      ok,
      pass: 'probe',
      backend: 'probe',
      backendLabel: 'OS probe',
      message: formatProbeMessage(ok)
    }
  }

  if (!plan.primary) {
    return {
      ok: false,
      pass: 'vision',
      message: formatVisionMessage({ ok: false, noBackend: true })
    }
  }

  let image: string
  try {
    image = (await deps.capture()).image
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      pass: 'vision',
      message: formatVisionMessage({
        ok: false,
        reason: reason || 'Could not capture a frame.'
      })
    }
  }
  if (!image) {
    return {
      ok: false,
      pass: 'vision',
      message: formatVisionMessage({ ok: false, reason: 'Capture returned an empty frame.' })
    }
  }

  const attempt = async (
    backend: VisionBackend
  ): Promise<{ ok: boolean; label: string; preview: string; reason?: string }> => {
    try {
      const { text, label } = await deps.askVision(backend, image)
      const verdict = interpretVisionReply(text)
      if (verdict.sawShot) return { ok: true, label, preview: verdict.preview }
      return {
        ok: false,
        label,
        preview: verdict.preview,
        reason: verdict.preview ? `Model said: ${verdict.preview}` : 'The model returned no evidence it saw the shot.'
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { ok: false, label: backend === 'local' ? 'Local AI' : 'API', preview: '', reason }
    }
  }

  const first = await attempt(plan.primary)
  if (first.ok) {
    return {
      ok: true,
      pass: 'vision',
      backend: plan.primary,
      backendLabel: first.label,
      failedOver: false,
      message: formatVisionMessage({ ok: true, backendLabel: first.label }),
      preview: first.preview
    }
  }

  if (!plan.failover) {
    return {
      ok: false,
      pass: 'vision',
      backend: plan.primary,
      backendLabel: first.label,
      failedOver: false,
      message: formatVisionMessage({ ok: false, backendLabel: first.label, reason: first.reason }),
      preview: first.preview
    }
  }

  const second = await attempt(plan.failover)
  if (second.ok) {
    return {
      ok: true,
      pass: 'vision',
      backend: plan.failover,
      backendLabel: second.label,
      failedOver: true,
      message: formatVisionMessage({ ok: true, backendLabel: second.label, failedOver: true }),
      preview: second.preview
    }
  }

  return {
    ok: false,
    pass: 'vision',
    backend: plan.failover,
    backendLabel: second.label,
    failedOver: true,
    message: formatVisionMessage({
      ok: false,
      backendLabel: `${first.label} then ${second.label}`,
      reason: [first.reason, second.reason].filter(Boolean).join(' ')
    }),
    preview: second.preview || first.preview
  }
}
