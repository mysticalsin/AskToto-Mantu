import type { AskTurnObservation } from './ask-turn'

/** Calls every observer in order; one throwing never blocks the others (observation is best effort). */
export function fanOutAskObservers(
  ...observers: Array<(event: AskTurnObservation) => void>
): (event: AskTurnObservation) => void {
  return (event) => {
    for (const observer of observers) {
      try {
        observer(event)
      } catch {
        /* one observer cannot block another */
      }
    }
  }
}
