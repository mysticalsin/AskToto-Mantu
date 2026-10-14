/** Prevents a slower earlier capability read from replacing a newer authorization result. */
export function createCloudSpeechRequestFence(): {
  begin(): number
  isCurrent(requestId: number): boolean
  invalidate(): void
} {
  let latest = 0
  return {
    begin: () => ++latest,
    isCurrent: (requestId) => requestId === latest,
    invalidate: () => {
      latest++
    }
  }
}
