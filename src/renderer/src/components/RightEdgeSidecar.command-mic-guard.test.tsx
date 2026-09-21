import { describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent, ReactElement } from 'react'

const hooks = vi.hoisted(() => ({
  useState<T>(initial: T): [T, (value: T) => void] {
    return [initial, () => {}]
  },
  useEffect(effect: () => void | (() => void)): void {
    void effect()
  }
}))

const commandMic = vi.hoisted(() => ({
  snapshot: {
    status: 'idle' as 'idle' | 'starting' | 'listening' | 'finalizing' | 'error',
    reason: undefined as undefined,
    start: vi.fn(async () => {}),
    cancel: vi.fn()
  }
}))

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: hooks.useState,
  useEffect: hooks.useEffect
}))

vi.mock('../lib/use-command-mic', () => ({
  useCommandMic: () => commandMic.snapshot
}))

import { RightEdgeSidecar } from './RightEdgeSidecar'

type ElementNode = ReactElement<{
  children?: unknown
  'aria-label'?: string
  'data-metis-command-mic-status'?: string
  disabled?: boolean
  onClick?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}>

function findByAriaLabel(node: unknown, label: string): ElementNode | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByAriaLabel(child, label)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as ElementNode
  if (element.props['aria-label'] === label) return element
  return findByAriaLabel(element.props.children, label)
}

function findMicStatus(node: unknown): ElementNode | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findMicStatus(child)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as ElementNode
  if (element.props['data-metis-command-mic-status'] === '1') return element
  return findMicStatus(element.props.children)
}

function renderSidecar(meetingListening: boolean, onClose = vi.fn()): ReactElement {
  return RightEdgeSidecar({
    open: true,
    onOpen: vi.fn(),
    onClose,
    commandState: { proposalId: null },
    meetingListening
  })
}

describe('right-edge command microphone guard', () => {
  it('does not request a second microphone while a meeting is listening', () => {
    commandMic.snapshot.status = 'idle'
    commandMic.snapshot.start.mockClear()

    const tree = renderSidecar(true)
    const button = findByAriaLabel(tree, 'Test microphone access')
    button?.props.onClick?.()

    expect(button?.props.disabled).toBe(true)
    expect(commandMic.snapshot.start).not.toHaveBeenCalled()
    expect(findMicStatus(tree)?.props.children).toContain('meeting is currently listening')
  })

  it('keeps command mic access usable when no meeting is listening', () => {
    commandMic.snapshot.status = 'idle'
    commandMic.snapshot.start.mockClear()

    const tree = renderSidecar(false)
    findByAriaLabel(tree, 'Test microphone access')?.props.onClick?.()

    expect(commandMic.snapshot.start).toHaveBeenCalledOnce()
  })

  it('releases an existing command microphone lease when a meeting starts listening', () => {
    commandMic.snapshot.status = 'listening'
    commandMic.snapshot.cancel.mockClear()

    renderSidecar(true)

    expect(commandMic.snapshot.cancel).toHaveBeenCalledOnce()
  })

  it('contains Escape in the drawer after closing it locally', () => {
    const onClose = vi.fn()
    commandMic.snapshot.status = 'idle'
    commandMic.snapshot.cancel.mockClear()
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    const tree = renderSidecar(false, onClose)
    findByAriaLabel(tree, 'Métis command')?.props.onKeyDown?.({
      key: 'Escape',
      preventDefault,
      stopPropagation
    } as unknown as KeyboardEvent<HTMLElement>)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(commandMic.snapshot.cancel).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
