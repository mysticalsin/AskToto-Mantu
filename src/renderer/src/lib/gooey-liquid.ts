/**
 * Lazy liquid-gooey load. Never a static import — Vite must not purple-screen
 * the tour if the package is missing or throws.
 */
import type { ComponentType, ReactNode } from 'react'

export type LiquidProps = {
  blur?: number
  contrast?: number
  fill?: string
  shadow?: string
  waviness?: number
  className?: string
  children?: ReactNode
  onPointerDown?: () => void
  onPointerUp?: () => void
  onPointerLeave?: () => void
  onPointerCancel?: () => void
  'data-gooey'?: string
  'data-gooey-live'?: string
}

export type LiquidItemProps = {
  scale?: number
  transition?: string
  morph?: { shape?: boolean; bounce?: number; speed?: number; contentBlur?: number }
  children?: ReactNode
}

export type LiquidComponent = ComponentType<LiquidProps> & {
  Item: ComponentType<LiquidItemProps>
}

function isLiquidComponent(value: unknown): value is LiquidComponent {
  if (value == null || (typeof value !== 'function' && typeof value !== 'object')) return false
  const item = (value as { Item?: unknown }).Item
  return item != null && (typeof item === 'function' || typeof item === 'object')
}

export async function loadLiquidGooey(
  importer: () => Promise<{ Liquid?: unknown }> = () => import('liquid-gooey')
): Promise<LiquidComponent | null> {
  try {
    const mod = await importer()
    return isLiquidComponent(mod?.Liquid) ? mod.Liquid : null
  } catch {
    return null
  }
}
