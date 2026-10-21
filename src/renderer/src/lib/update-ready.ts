import { useEffect, type Dispatch, type SetStateAction } from 'react'

/** The in-app updater's toast state: downloading (percent), or ready to restart (version/notes). */
export interface UpdateReadyState {
  open: boolean
  version?: string
  notes?: string
  percent?: number
}

/** Mirrors main's updater events into App's `updateReady` state. */
export function useUpdateReadySubscription(setUpdateReady: Dispatch<SetStateAction<UpdateReadyState>>): void {
  useEffect(() => {
    const offReady = window.toto.onUpdateReady((d) =>
      setUpdateReady({ open: true, version: d?.version, notes: d?.notes })
    )
    // Show a "Downloading… X%" state while the update downloads; once it's ready (version set), keep that.
    const offProgress = window.toto.onUpdateProgress((d) =>
      setUpdateReady((prev) => (prev.version ? prev : { open: true, percent: d?.percent }))
    )
    return () => {
      offReady()
      offProgress()
    }
  }, [])
}
