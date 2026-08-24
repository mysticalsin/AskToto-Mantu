/**
 * Thin re-export: the VAD state machine now lives in `src/shared/vad.ts` so the same implementation drives
 * both the live worklet (via `.toString()` transplant, see `whisper-worklet-src.ts`) and the batch
 * main-process import path (`vadWindowsFromPcm`). This file stays in place, unchanged in behavior, so
 * nothing that imports `./vad` from the renderer (`whisper-worklet-src.ts`, `vad.test.ts`) has to churn.
 */
export { makeVad, isSpeechLikeWindow } from '@shared/vad'
