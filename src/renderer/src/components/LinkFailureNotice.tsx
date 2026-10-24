import { useEffect, useRef, useState } from 'react'
import { LINK_OPEN_FAILED_NOTICE } from '@shared/links'

const WIDTH = 220
const GAP = 16
const EDGE = 8
const SHOW_MS = 3500

export function noticePosition(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number }
): { x: number; y: number } {
  const x = Math.min(Math.max(pointer.x, EDGE), viewport.width - WIDTH - EDGE)
  const y = Math.min(Math.max(pointer.y + GAP, GAP), viewport.height - 40)
  return { x, y }
}

export function LinkFailureNoticeView({ at }: { at: { x: number; y: number } | null }): JSX.Element | null {
  if (!at) return null
  return (
    <div
      role="alert"
      style={{ position: 'fixed', left: `${at.x}px`, top: `${at.y}px`, width: `${WIDTH}px`, zIndex: 50 }}
      className="pointer-events-none rounded-lg border border-[var(--color-danger)]/30 bg-black/80 px-2 py-1 text-[11px] text-[var(--color-danger)] shadow-lg"
    >
      {LINK_OPEN_FAILED_NOTICE}
    </div>
  )
}

/**
 * Transient feedback for a link that did not open (G55), shown next to where the user last pressed the pointer.
 * Mounted once in the answer surface; main pushes the event with no URL, so the copy is always the same fixed line.
 */
export function LinkFailureNotice(): JSX.Element | null {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const pointer = useRef({ x: 16, y: 16 })
  useEffect(() => {
    const track = (e: PointerEvent): void => {
      pointer.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointerdown', track, true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.toto?.onLinkOpenFailed?.(() => {
      setAt(noticePosition(pointer.current, { width: window.innerWidth, height: window.innerHeight }))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setAt(null), SHOW_MS)
    })
    return () => {
      window.removeEventListener('pointerdown', track, true)
      off?.()
      if (timer) clearTimeout(timer)
    }
  }, [])
  return <LinkFailureNoticeView at={at} />
}
