import { useEffect, useRef } from 'react'
import { animate } from 'framer-motion'

interface Props {
  value: number
  decimals?: number
  suffix?: string
  className?: string
}

export function CountUp({ value, decimals = 0, suffix = '', className }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const lastRef = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const from = lastRef.current
    const controls = animate(from, value, {
      duration: 0.9,
      ease: 'easeOut',
      onUpdate(v) {
        el.textContent = `${v.toFixed(decimals)}${suffix}`
        lastRef.current = v
      },
    })
    return () => controls.stop()
  }, [value, decimals, suffix])

  return <span ref={ref} className={className} />
}
