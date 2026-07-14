export interface BrainBackfillGateState {
  attempted: boolean
  loading: boolean
  running: boolean
  savedMeetings: number
  ingestedMeetings: number
  savedMeetingFiles?: string[]
  ingestedFiles?: string[]
}

/**
 * Opening an Intelligence surface is an explicit request to see current meeting knowledge. Start one
 * backlog pass when saved transcripts are ahead of the successful-ingest count, but never restart a
 * pass while it is loading/running or after this surface already made its attempt.
 */
export function shouldAutoBackfill(state: BrainBackfillGateState): boolean {
  if (state.attempted || state.loading || state.running) return false
  if (state.savedMeetingFiles && state.ingestedFiles) {
    const ingested = new Set(state.ingestedFiles)
    return state.savedMeetingFiles.some((file) => !ingested.has(file))
  }
  return state.savedMeetings > state.ingestedMeetings
}
