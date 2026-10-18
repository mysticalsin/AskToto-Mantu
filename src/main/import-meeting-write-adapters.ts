import type { Settings } from '@shared/ipc'
import type { ImportJobManagerDeps } from './import-job-types'
import type { saveMeeting } from './transcripts'
import type { updateMeetingRecap } from './recall'

interface ImportMeetingWriteDependencies {
  getSettings: () => Settings
  saveMeeting: typeof saveMeeting
  updateMeetingRecap: typeof updateMeetingRecap
}

/** Bind main's meeting writers without losing the import attempt's replacement-time guard. */
export function createImportMeetingWriteAdapters(
  deps: ImportMeetingWriteDependencies
): Pick<ImportJobManagerDeps, 'saveMeeting' | 'updateRecap'> {
  return {
    saveMeeting: (meeting, beforeReplace) => deps.saveMeeting(deps.getSettings(), meeting, beforeReplace),
    updateRecap: async (file, recap, status, beforeReplace) => {
      const result = await deps.updateMeetingRecap(deps.getSettings(), file, recap, status, beforeReplace)
      if (!result.ok) throw new Error(result.error || 'Could not save the imported summary.')
    }
  }
}
