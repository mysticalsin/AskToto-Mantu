export interface ScreenPreprocessRefresh {
  stop: () => void
}

export function startScreenPreprocessRefresh(onTick: () => void, intervalMs: number): ScreenPreprocessRefresh {
  const timer = setInterval(onTick, intervalMs)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer)
  }
}
