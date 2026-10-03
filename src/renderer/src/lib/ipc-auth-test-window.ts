export function installIpcAuthTestWindow(toto: Partial<Window['toto']> = {}): Event[] {
  const events: Event[] = []
  const target = new EventTarget()
  const windowStub = {
    toto,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target)
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowStub
  })
  return events
}
