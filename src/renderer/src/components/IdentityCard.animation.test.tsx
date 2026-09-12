// MQA-305: the real card spring must stop requesting frames and writing styles once it settles.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react'
import { emptyLicenseStatus, type IdentitySnapshot } from '@shared/ipc'
import { IdentityCard } from './IdentityCard'

// Hook commits, DOM style setters, and the browser frame clock are the boundary doubles. Gesture
// handlers, spring integration, transforms, and effect cleanup all execute the production component.
const hooks = vi.hoisted(() => {
  let slots: unknown[] = []
  let cursor = 0
  let pending: Array<() => void> = []
  let dirty = false
  const effects = new Set<{ cleanup?: () => void }>()
  const next = <T,>(initial: () => T): T => {
    const index = cursor++
    if (!(index in slots)) slots[index] = initial()
    return slots[index] as T
  }
  const equal = (a: readonly unknown[] | undefined, b: readonly unknown[]): boolean =>
    !!a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  return {
    useRef: <T,>(current: T) => next(() => ({ current })),
    useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
      const slot = next(() => ({ value: initial }))
      return [slot.value, (value) => {
        const updated = typeof value === 'function' ? (value as (previous: T) => T)(slot.value) : value
        if (!Object.is(slot.value, updated)) { slot.value = updated; dirty = true }
      }]
    },
    useCallback<T>(value: T, deps: readonly unknown[]): T {
      const slot = next(() => ({ value, deps }))
      if (!equal(slot.deps, deps)) { slot.value = value; slot.deps = deps }
      return slot.value
    },
    useEffect(run: () => void | (() => void), deps: readonly unknown[]): void {
      const slot = next<{ deps?: readonly unknown[]; cleanup?: () => void }>(() => ({}))
      effects.add(slot)
      if (!equal(slot.deps, deps)) {
        slot.deps = deps
        pending.push(() => { slot.cleanup?.(); slot.cleanup = run() || undefined })
      }
    },
    begin(): void { cursor = 0; dirty = false },
    commit(): void { const work = pending; pending = []; work.forEach((run) => run()) },
    dirty: () => dirty,
    unmount(): void { effects.forEach((effect) => effect.cleanup?.()); effects.clear() },
    reset(): void { slots = []; cursor = 0; pending = []; dirty = false; effects.clear() }
  }
})

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: hooks.useRef,
  useState: hooks.useState,
  useCallback: hooks.useCallback,
  useEffect: hooks.useEffect,
  useId: () => 'identity-card-animation-fixture'
}))

const SNAPSHOT: IdentitySnapshot = {
  installId: '11111111-1111-4111-8111-111111111111', installedAt: '2026-09-12T00:00:00.000Z',
  installedAtLabel: 'Installed 12 Sep 2026', memberNumber: null, memberNumberLabel: 'pending',
  deviceName: 'Synthetic QA device', serialKind: 'install', serialDisplay: 'fixture', license: emptyLicenseStatus()
}
type CardProps = {
  'aria-pressed': boolean
  onPointerMove(event: PointerEvent<HTMLDivElement>): void
  onPointerDown(event: PointerEvent<HTMLDivElement>): void
  onPointerUp(): void
  onPointerLeave(): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
}

function mount(reducedMotion = false) {
  hooks.reset()
  let now = 0
  let frameId = 0
  let writes = 0
  let transform = ''
  let background = ''
  const frames = new Map<number, FrameRequestCallback>()
  const doc = Object.assign(new EventTarget(), { hidden: false })
  const card = {
    style: { get transform() { return transform }, set transform(value: string) { transform = value; writes++ } },
    querySelector: () => ({ style: {
      get background() { return background }, set background(value: string) { background = value; writes++ }
    } }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: vi.fn()
  }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId; frames.set(id, callback); return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  let props: CardProps
  const render = (): void => {
    hooks.begin()
    const tree = IdentityCard({ snapshot: SNAPSHOT, reducedMotion }) as ReactElement<{ children: ReactElement<CardProps> }>
    const element = tree.props.children as ReactElement<CardProps> & { ref: { current: unknown } }
    props = element.props
    element.ref.current = card
    hooks.commit()
  }
  const flush = (): void => { if (hooks.dirty()) render() }
  const frame = (): void => {
    now += 1000 / 60
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(now))
    flush()
  }
  render()
  return {
    queued: () => frames.size,
    writes: () => writes,
    transform: () => transform,
    background: () => background,
    flipped: () => props['aria-pressed'],
    frame,
    settle(): void { for (let count = 0; frames.size && count < 240; count++) frame() },
    pointer(kind: 'move' | 'down' | 'up' | 'leave', x = 50, y = 50): void {
      const event = { clientX: x, clientY: y, pointerId: 1, currentTarget: card } as unknown as PointerEvent<HTMLDivElement>
      if (kind === 'move') props.onPointerMove(event)
      else if (kind === 'down') props.onPointerDown(event)
      else if (kind === 'up') props.onPointerUp()
      else props.onPointerLeave()
      flush()
    },
    key(key: string): void {
      props.onKeyDown({ key, preventDefault: () => {} } as KeyboardEvent<HTMLDivElement>)
      flush()
    },
    visible(visible: boolean): void { doc.hidden = !visible; doc.dispatchEvent(new Event('visibilitychange')); flush() },
    reduced(value: boolean): void { reducedMotion = value; render() },
    unmount: () => hooks.unmount()
  }
}

afterEach(() => { hooks.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('MQA-305 — demand-driven identity card animation', () => {
  it('retains the initial card without scheduling frames or rewriting styles while idle', () => {
    const card = mount()
    card.frame()
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(0.00deg)')
    expect(card.queued()).toBe(0)
    const writes = card.writes()
    for (let index = 0; index < 120; index++) card.frame()
    expect(card.writes()).toBe(writes)
  })

  it('wakes for pointer tilt, sleeps at the target, and animates back on leave', () => {
    const card = mount()
    card.frame()
    card.pointer('move', 100, 100)
    expect(card.queued()).toBe(1)
    card.settle()
    expect(card.transform()).toBe('rotateX(-8.00deg) rotateY(12.00deg)')
    expect(card.background()).toContain('82% 68%')
    expect(card.queued()).toBe(0)
    card.pointer('leave')
    expect(card.queued()).toBe(1)
    card.settle()
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(0.00deg)')
    expect(card.queued()).toBe(0)
  })

  it('wakes for keyboard flips and sleeps on either completed face', () => {
    const card = mount()
    card.frame()
    card.key('Enter')
    card.settle()
    expect(card.flipped()).toBe(true)
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(180.00deg)')
    expect(card.queued()).toBe(0)
    card.key('ArrowLeft')
    card.settle()
    expect(card.flipped()).toBe(false)
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(0.00deg)')
    expect(card.queued()).toBe(0)
  })

  it('retains a held drag without idle work and snaps to the selected face after release', () => {
    const card = mount()
    card.frame()
    card.pointer('down', 50, 50)
    card.pointer('move', 250, 50)
    card.settle()
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(122.00deg)') // 110-degree drag + 12-degree tilt
    expect(card.queued()).toBe(0)
    card.pointer('up')
    card.pointer('leave')
    card.settle()
    expect(card.flipped()).toBe(true)
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(180.00deg)')
    expect(card.queued()).toBe(0)
  })

  it('pauses hidden animation, resumes on visibility, and cannot restart after unmount', () => {
    const card = mount()
    card.key('Enter')
    card.frame()
    card.visible(false)
    expect(card.queued()).toBe(0)
    const hiddenWrites = card.writes()
    card.pointer('move', 100, 100)
    card.frame()
    expect(card.writes()).toBe(hiddenWrites)
    card.visible(true)
    expect(card.queued()).toBe(1)
    card.settle()
    expect(card.transform()).toBe('rotateX(-8.00deg) rotateY(192.00deg)')
    expect(card.queued()).toBe(0)
    card.key('Enter')
    card.unmount()
    const unmountedWrites = card.writes()
    card.visible(false)
    card.visible(true)
    card.frame()
    expect(card.queued()).toBe(0)
    expect(card.writes()).toBe(unmountedWrites)
  })

  it('keeps reduced-motion flip controls usable without spring frames or sheen', () => {
    const card = mount(true)
    card.pointer('move', 100, 100)
    card.key('Enter')
    expect(card.flipped()).toBe(true)
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(180.00deg)')
    expect(card.background()).toBe('transparent')
    expect(card.queued()).toBe(0)
    card.pointer('down')
    card.pointer('up')
    expect(card.flipped()).toBe(false)
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(0.00deg)')
    expect(card.queued()).toBe(0)
  })

  it('cancels an in-flight spring when reduced motion is enabled', () => {
    const card = mount()
    card.key('Enter')
    card.frame()
    card.reduced(true)
    expect(card.transform()).toBe('rotateX(0.00deg) rotateY(180.00deg)')
    expect(card.queued()).toBe(0)
  })
})
