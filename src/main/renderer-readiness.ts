/** MQA-318: a read-only, bounded probe of our loaded document, not workflow or visual QA. */
export const RENDERER_READY_PROBE = `(() => new Promise((resolve) => {
  const deadline = Date.now() + 10000;
  const check = () => {
    const root = document.getElementById('root');
    if (document.readyState === 'complete' && typeof window.toto?.getSettings === 'function' && root?.childElementCount > 0) {
      resolve(true);
    } else if (Date.now() >= deadline) {
      resolve(false);
    } else {
      setTimeout(check, 100);
    }
  };
  check();
}))()`

interface RendererReadyTarget {
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
  getURL(): string
  isDestroyed(): boolean
  executeJavaScript(source: string): Promise<unknown>
}

/** Bind before navigation. A reload, failed load, or destroyed renderer invalidates an older probe. */
export function bindRendererReadiness(
  target: RendererReadyTarget,
  expectedUrl: string,
  ready: () => void
): void {
  let generation = 0
  let cancelProbe: (() => void) | undefined
  const cancel = (): void => {
    generation += 1
    cancelProbe?.()
    cancelProbe = undefined
  }
  const dispose = (): void => {
    cancel()
    target.removeListener('did-finish-load', loaded)
    for (const event of ['did-start-loading', 'did-fail-load', 'render-process-gone']) target.removeListener(event, cancel)
    target.removeListener('destroyed', dispose)
  }
  const loaded = (): void => {
    cancel()
    if (target.isDestroyed() || target.getURL() !== expectedUrl) return
    const current = generation
    // A wedged renderer may never execute even the probe's own timeout. Bound the main-side wait too.
    const cancelled = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000)
      cancelProbe = () => { clearTimeout(timer); resolve(false) }
    })
    void Promise.race([
      Promise.resolve().then(() => {
        if (current !== generation || target.isDestroyed() || target.getURL() !== expectedUrl) return false
        return target.executeJavaScript(RENDERER_READY_PROBE)
      }),
      cancelled
    ]).then((result) => {
      if (result !== true || current !== generation || target.isDestroyed() || target.getURL() !== expectedUrl) return
      dispose()
      ready()
    }).catch(() => {
      // No ready signal is safer than a false pass; the launch gate reports its bounded failure.
    }).finally(() => {
      if (current === generation) cancel()
    })
  }
  target.on('did-finish-load', loaded)
  for (const event of ['did-start-loading', 'did-fail-load', 'render-process-gone']) target.on(event, cancel)
  target.on('destroyed', dispose)
}
