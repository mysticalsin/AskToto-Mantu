import { desktopCapturer } from 'electron'
import { extractScreenOcrWords } from '../../mac-helper'
import { captureSingleWindowSource } from '../../screen-capture'
import { runWindowOcr, type OcrRequest, type OcrRunResult, type OcrSessionPort } from './index'

export function runInteractionWindowOcr(request: OcrRequest, sessions: OcrSessionPort): Promise<OcrRunResult> {
  return runWindowOcr(request, {
    sessions,
    capture: {
      capture: (target) => captureSingleWindowSource(target, (options) => desktopCapturer.getSources(options))
    },
    helper: {
      recognize: (image) => {
        const invocation = process.platform === 'darwin' ? extractScreenOcrWords(image) : null
        if (invocation) return invocation
        return {
          result: Promise.reject(new Error('On-device window OCR is unavailable on this platform.')),
          kill: () => {}
        }
      }
    }
  })
}
