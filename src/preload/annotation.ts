import { contextBridge, ipcRenderer } from 'electron'
import type { MarkView } from '../shared/screen-marks'

/**
 * Preload for the annotation window (G43): the only thing it can do is receive the marks to draw. It cannot call
 * main. The channel name equals SCREEN_MARKS_IPC.marks (pinned by a test). Only types are imported from shared: a
 * value import shared with the main preload would make Rollup split a chunk, and a sandboxed preload cannot
 * require() secondary chunks. So the payload is checked here by shape, and a malformed one is dropped.
 */
const MAX_MARKS = 24
const KINDS = new Set(['point', 'box', 'arrow', 'label-anchor'])
const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const pt = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && num((v as { x?: unknown }).x) && num((v as { y?: unknown }).y)

function wellFormed(payload: unknown): payload is MarkView[] {
  if (!Array.isArray(payload) || payload.length > MAX_MARKS) return false
  return payload.every((m: Record<string, unknown> | null) => {
    if (typeof m !== 'object' || m === null || typeof m.markId !== 'string' || !KINDS.has(m.kind as string))
      return false
    if (m.kind === 'arrow') return pt(m.from) && pt(m.to)
    if (m.kind === 'box') return pt(m) && num(m.width) && num(m.height)
    return pt(m)
  })
}

const api = {
  onMarks(listener: (marks: MarkView[]) => void): () => void {
    const handler = (_event: unknown, payload: unknown): void => {
      if (wellFormed(payload)) listener(payload)
    }
    ipcRenderer.on('annotation:marks', handler)
    return () => ipcRenderer.removeListener('annotation:marks', handler)
  }
}

contextBridge.exposeInMainWorld('metisAnnotation', api)
