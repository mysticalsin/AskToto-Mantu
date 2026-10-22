export type StopDrainOutcome = 'drained' | 'aborted' | 'revoked'
export type StopDrainCallback = (outcome: StopDrainOutcome) => void

export function settleStopCallbacks(operation: { callbacks: StopDrainCallback[] }, outcome: StopDrainOutcome): void {
  const callbacks = operation.callbacks.splice(0)
  for (const callback of callbacks) {
    try {
      callback(outcome)
    } catch (error) {
      console.warn('[listen] stop drain callback failed:', error)
    }
  }
}
