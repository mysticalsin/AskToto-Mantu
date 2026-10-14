/// <reference lib="webworker" />

self.onmessage = (): void => {
  self.postMessage({ type: 'error', message: 'The optional offline speech runtime is unavailable.' })
}
