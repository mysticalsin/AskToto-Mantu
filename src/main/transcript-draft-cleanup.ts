import { dirname, join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { resolveMeetingsFolder } from './infra/storage/paths'
import { draftFilename } from './infra/storage/draft-transcript-write-state'
import { stamp } from './features/meetings/transcript-document-format'

/** Every folder a meeting's autosave draft may live in: the current meetings folder and, when known,
 *  the folder its durable save landed in. Each lookup is best-effort so known paths still clean up. */
export function draftCleanupCandidates(settings: Settings, startedAt: number, savedTranscriptPath?: string): string[] {
  const candidateFiles: string[] = []
  let filename: string | undefined
  try {
    filename = draftFilename(startedAt, stamp(startedAt))
  } catch {
    /* still seal the meeting identity */
  }
  if (filename) {
    try {
      candidateFiles.push(join(resolveMeetingsFolder(settings), filename))
    } catch {
      /* known paths still clean up */
    }
    if (savedTranscriptPath) {
      try {
        candidateFiles.push(join(dirname(savedTranscriptPath), filename))
      } catch {
        /* known paths still clean up */
      }
    }
  }
  return candidateFiles
}
