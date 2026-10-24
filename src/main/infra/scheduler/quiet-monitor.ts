/** The quiet-mode signal poll (G68): re-reads call, screen-share and Focus signals so deferred output releases on exit. */
export function startQuietMonitor(refresh: () => void, everyMs: number): () => void {
  const timer = setInterval(refresh, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
