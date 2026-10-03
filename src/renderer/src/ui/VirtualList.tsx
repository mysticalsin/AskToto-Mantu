import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'

export type VirtualListRenderArg<T> = {
  item: T
  index: number
  style: CSSProperties
  measureRef: (node: HTMLDivElement | null) => void
}

export type VirtualListProps<T> = {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  estimateSize: (item: T, index: number) => number
  renderItem: (arg: VirtualListRenderArg<T>) => ReactNode
  className?: string
  contentClassName?: string
  role?: string
  ariaLabel?: string
  overscan?: number
  initialViewportHeight?: number
}

export type VirtualWindow = {
  start: number
  end: number
  offsetTop: number
  totalSize: number
}

export function virtualWindow(
  sizes: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): VirtualWindow {
  const totalSize = sizes.reduce((sum, n) => sum + n, 0)
  if (sizes.length === 0) return { start: 0, end: 0, offsetTop: 0, totalSize }

  const safeTop = Math.max(0, scrollTop)
  const safeBottom = safeTop + Math.max(0, viewportHeight)
  let start = 0
  let offsetTop = 0
  while (start < sizes.length && offsetTop + sizes[start] <= safeTop) {
    offsetTop += sizes[start]
    start += 1
  }

  let end = start
  let offset = offsetTop
  while (end < sizes.length && offset <= safeBottom) {
    offset += sizes[end]
    end += 1
  }

  start = Math.max(0, start - overscan)
  end = Math.min(sizes.length, end + overscan)
  offsetTop = sizes.slice(0, start).reduce((sum, n) => sum + n, 0)
  return { start, end, offsetTop, totalSize }
}

function VirtualListInner<T>({
  items,
  getKey,
  estimateSize,
  renderItem,
  className,
  contentClassName,
  role = 'list',
  ariaLabel,
  overscan = 6,
  initialViewportHeight = 360
}: VirtualListProps<T>): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight)
  const [measuredSizes, setMeasuredSizes] = useState<Map<string, number>>(() => new Map())

  const sizes = useMemo(
    () => items.map((item, index) => measuredSizes.get(getKey(item, index)) ?? estimateSize(item, index)),
    [estimateSize, getKey, items, measuredSizes]
  )
  const windowed = useMemo(
    () => virtualWindow(sizes, scrollTop, viewportHeight, overscan),
    [overscan, scrollTop, sizes, viewportHeight]
  )
  const visible = items.slice(windowed.start, windowed.end)

  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    setViewportHeight(node.clientHeight || initialViewportHeight)
  }, [initialViewportHeight])

  useEffect(() => {
    const node = scrollerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height || initialViewportHeight)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [initialViewportHeight])

  const rememberSize = useCallback((key: string, size: number): void => {
    if (!Number.isFinite(size) || size <= 0) return
    setMeasuredSizes((prev) => {
      if (prev.get(key) === size) return prev
      const next = new Map(prev)
      next.set(key, size)
      return next
    })
  }, [])

  return (
    <div
      ref={scrollerRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className={contentClassName} style={{ height: windowed.totalSize, position: 'relative' }}>
        {visible.map((item, visibleIndex) => {
          const index = windowed.start + visibleIndex
          const key = getKey(item, index)
          const top = windowed.offsetTop + sizes.slice(windowed.start, index).reduce((sum, n) => sum + n, 0)
          const measureRef = (node: HTMLDivElement | null): void => {
            if (node) rememberSize(key, Math.ceil(node.getBoundingClientRect().height))
          }
          return (
            <Fragment key={key}>
              {renderItem({
                item,
                index,
                measureRef,
                style: { position: 'absolute', top, left: 0, right: 0 }
              })}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

export const VirtualList = memo(VirtualListInner) as typeof VirtualListInner
