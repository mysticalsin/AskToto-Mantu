import type { ScreenRegion } from '@shared/screen-observation'

type Rect = { x: number; y: number; width: number; height: number }

/** The part of Electron's NativeImage a region capture needs, so the crop is testable without Electron. */
export interface CroppableImage {
  getSize(): { width: number; height: number }
  crop(rect: Rect): CroppableImage
}

/**
 * Crop a frame to a region given as fractions of the display. The rectangle is clamped to whole pixels that
 * lie inside the frame and is never empty, so a sliver at the far edge cannot ask the OS for a zero-sized
 * or out-of-bounds crop.
 */
export function cropNormalizedRegion<T extends CroppableImage>(image: T, region: ScreenRegion): T {
  const { width: w, height: h } = image.getSize()
  const x = Math.min(Math.max(0, Math.floor(region.x * w)), Math.max(0, w - 1))
  const y = Math.min(Math.max(0, Math.floor(region.y * h)), Math.max(0, h - 1))
  const width = Math.max(1, Math.min(w - x, Math.round(region.width * w)))
  const height = Math.max(1, Math.min(h - y, Math.round(region.height * h)))
  return image.crop({ x, y, width, height }) as T
}
