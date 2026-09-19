import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Cleanup = void | (() => void)

/**
 * This focused hooks host is enough for `useAutoResize`: it gives the callback ref stable refs and
 * callbacks without adding a DOM test dependency to the node-based renderer suite.
 */
const host = vi.hoisted(() => {
  let hooks: unknown[] = []
  let hookIndex = 0
  return {
    useRef<T>(initial: T): { current: T } {
      const i = hookIndex++
      if (!(i in hooks)) hooks[i] = { current: initial }
      return hooks[i] as { current: T }
    },
    useCallback<T>(fn: T): T {
      hookIndex++
      return fn
    },
    useEffect(_effect: () => Cleanup): void {
      hookIndex++
    },
    useMemo<T>(factory: () => T): T {
      hookIndex++
      return factory()
    },
    useState<T>(initial: T): [T, () => void] {
      hookIndex++
      return [initial, () => {}]
    },
    startTransition(fn: () => void): void {
      fn()
    },
    reset(): void {
      hooks = []
      hookIndex = 0
    }
  }
})

vi.mock('react', () => ({
  useRef: host.useRef,
  useCallback: host.useCallback,
  useEffect: host.useEffect,
  useMemo: host.useMemo,
  useState: host.useState,
  startTransition: host.startTransition
}))

import { useAutoResize } from './state'

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: () => void) {
    ResizeObserverStub.instances.push(this)
  }

  fire(): void {
    this.callback()
  }
}

class MutationObserverStub {
  static instances: MutationObserverStub[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: () => void) {
    MutationObserverStub.instances.push(this)
  }

  fire(): void {
    this.callback()
  }
}

function rootElement(): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top: 0, bottom: 90 }),
    querySelector: () => null,
    querySelectorAll: () => []
  } as unknown as HTMLElement
}

describe('useAutoResize frame scheduling', () => {
  const resize = vi.fn()
  const frameCallbacks = new Map<number, FrameRequestCallback>()
  const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
    const id = frameCallbacks.size + 1
    frameCallbacks.set(id, callback)
    return id
  })
  const cancelFrame = vi.fn((id: number): void => {
    frameCallbacks.delete(id)
  })

  beforeEach(() => {
    host.reset()
    ResizeObserverStub.instances = []
    MutationObserverStub.instances = []
    frameCallbacks.clear()
    requestFrame.mockClear()
    cancelFrame.mockClear()
    resize.mockClear()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('MutationObserver', MutationObserverStub)
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    vi.stubGlobal('window', { toto: { resize } })
    vi.stubGlobal('document', { visibilityState: 'visible' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('coalesces normal resize notifications into one animation-frame measurement', async () => {
    const setRoot = useAutoResize()
    setRoot(rootElement())
    ResizeObserverStub.instances[0].fire()
    MutationObserverStub.instances[0].fire()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(resize).not.toHaveBeenCalled()

    const frame = frameCallbacks.get(1)
    expect(frame).toBeTypeOf('function')
    frame?.(0)
    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('uses one bounded microtask fallback only while the renderer is hidden', async () => {
    ;(document as { visibilityState: string }).visibilityState = 'hidden'
    const setRoot = useAutoResize()
    setRoot(rootElement())
    ResizeObserverStub.instances[0].fire()
    MutationObserverStub.instances[0].fire()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(resize).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(resize).toHaveBeenCalledTimes(1)
    expect(cancelFrame).toHaveBeenCalledWith(1)
  })
})
