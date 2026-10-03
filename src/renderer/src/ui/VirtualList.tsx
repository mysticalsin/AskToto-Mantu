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

function upperBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid] <= target) low = mid + 1
    else high = mid
  }
  return low
}

function sizeOffsets(sizes: readonly number[]): number[] {
  const offsets: number[] = new Array(sizes.length + 1)
  offsets[0] = 0
  for (let i = 0; i < sizes.length; i++) offsets[i + 1] = offsets[i] + sizes[i]
  return offsets
}

export function virtualWindowFromOffsets(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): VirtualWindow {
  const itemCount = Math.max(0, offsets.length - 1)
  const totalSize = offsets[itemCount] ?? 0
  if (itemCount === 0) return { start: 0, end: 0, offsetTop: 0, totalSize }

  const safeTop = Math.max(0, scrollTop)
  const safeBottom = safeTop + Math.max(0, viewportHeight)
  let start = Math.max(0, upperBound(offsets, safeTop) - 1)
  let end = Math.min(itemCount, upperBound(offsets, safeBottom))

  start = Math.max(0, start - overscan)
  end = Math.min(itemCount, end + overscan)
  return { start, end, offsetTop: offsets[start] ?? 0, totalSize }
}

export function virtualWindow(
  sizes: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): VirtualWindow {
  return virtualWindowFromOffsets(sizeOffsets(sizes), scrollTop, viewportHeight, overscan)
}

function VirtualRow<T>({
  item,
  index,
  itemKey,
  style,
  renderItem,
  rememberSize
}: {
  item: T
  index: number
  itemKey: string
  style: CSSProperties
  renderItem: (arg: VirtualListRenderArg<T>) => ReactNode
  rememberSize: (key: string, size: number) => void
}): JSX.Element {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useCallback(
    (node: HTMLDivElement | null): void => {
      nodeRef.current = node
      if (node) rememberSize(itemKey, Math.ceil(node.getBoundingClientRect().height))
    },
    [itemKey, rememberSize]
  )

  useEffect(() => {
    const node = nodeRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      rememberSize(itemKey, Math.ceil(entry.contentRect.height))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [itemKey, rememberSize])

  return (
    <Fragment key={itemKey}>
      {renderItem({
        item,
        index,
        measureRef,
        style
      })}
    </Fragment>
  )
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
  const offsets = useMemo(() => {
    return sizeOffsets(sizes)
  }, [sizes])
  const windowed = useMemo(
    () => virtualWindowFromOffsets(offsets, scrollTop, viewportHeight, overscan),
    [offsets, overscan, scrollTop, viewportHeight]
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
          const top = offsets[index] ?? windowed.offsetTop
          return (
            <VirtualRow
              key={key}
              item={item}
              index={index}
              itemKey={key}
              style={{ position: 'absolute', top, left: 0, right: 0 }}
              renderItem={renderItem}
              rememberSize={rememberSize}
            />
          )
        })}
      </div>
    </div>
  )
}

export const VirtualList = memo(VirtualListInner) as typeof VirtualListInner
