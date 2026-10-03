import { OcrResultSchema, type OcrResult } from '@shared/contracts/ocr'
import type { CapturedWindowImage, SingleWindowCaptureTarget } from '../../screen-capture'

export type OcrFeatureStatus = 'COMPLETE' | 'PARTIAL' | 'UNAUTHORIZED' | 'LANGUAGE_UNAVAILABLE'

export type OcrSessionPort = {
  activeToken(): string | null
}

export type OcrCapturePort = {
  capture(target: SingleWindowCaptureTarget): Promise<CapturedWindowImage>
}

export type OcrHelperInvocation = {
  result: Promise<unknown>
  kill: () => void
}

export type OcrHelperPort = {
  recognize(image: Buffer, options: { languages: string[] }): OcrHelperInvocation
}

export type OcrRunResult =
  | { status: 'COMPLETE'; result: OcrResult }
  | { status: 'PARTIAL'; gap: string }
  | { status: 'UNAUTHORIZED'; gap: string }
  | { status: 'LANGUAGE_UNAVAILABLE'; language: string; gap: string }

export type OcrFeatureDeps = {
  sessions: OcrSessionPort
  capture: OcrCapturePort
  helper: OcrHelperPort
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export type OcrRequest = {
  sessionToken: string
  target: SingleWindowCaptureTarget
  languages?: string[]
  deadlineMs: number
}

const DEFAULT_LANGUAGES = ['en-US', 'fr-FR']

export async function runWindowOcr(request: OcrRequest, deps: OcrFeatureDeps): Promise<OcrRunResult> {
  if (!request.sessionToken || deps.sessions.activeToken() !== request.sessionToken) {
    return { status: 'UNAUTHORIZED', gap: 'OCR requires an active interaction-session token.' }
  }
  const deadlineMs = Math.max(1, Math.floor(request.deadlineMs))
  const timers = {
    setTimeout: deps.setTimeout ?? setTimeout,
    clearTimeout: deps.clearTimeout ?? clearTimeout
  }
  const captured = await deps.capture.capture(request.target)
  const helper = deps.helper.recognize(Buffer.from(captured.image, 'base64'), {
    languages: request.languages?.length ? request.languages : DEFAULT_LANGUAGES
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const output = await Promise.race([
      helper.result,
      new Promise<never>((_, reject) => {
        timer = timers.setTimeout(() => {
          helper.kill()
          reject(new Error('ocr-deadline'))
        }, deadlineMs)
      })
    ])
    const languageUnavailable = parseLanguageUnavailable(output)
    if (languageUnavailable) {
      return {
        status: 'LANGUAGE_UNAVAILABLE',
        language: languageUnavailable,
        gap: `On-device OCR language is unavailable: ${languageUnavailable}.`
      }
    }
    return { status: 'COMPLETE', result: OcrResultSchema.parse(output) }
  } catch (error) {
    if (error instanceof Error && error.message === 'ocr-deadline') {
      return { status: 'PARTIAL', gap: `OCR helper exceeded the ${deadlineMs} ms deadline and was killed before a complete result.` }
    }
    return { status: 'PARTIAL', gap: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer) timers.clearTimeout(timer)
  }
}

function parseLanguageUnavailable(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null
  const value = output as { status?: unknown; language?: unknown }
  return value.status === 'LANGUAGE_UNAVAILABLE' && typeof value.language === 'string' ? value.language : null
}
