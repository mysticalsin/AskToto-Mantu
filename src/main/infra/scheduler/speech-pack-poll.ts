/** One owned authorization refresh poll; teardown stops it before the pack service shuts down. */
export function startSpeechPackPoll(refresh: () => void): () => void {
  const timer = setInterval(refresh, 1000)
  timer.unref()
  return () => clearInterval(timer)
}

export function waitForSpeechPackQuitFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2000))
}
