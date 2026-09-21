/**
 * Tony HARD 2026-09-21: intended dock chat is OVERLAY_DOCK_PANEL ~380×560 (squarish).
 * Tall full-height rectangular chat must never show overlapping overlay text.
 */
export function dockChatIsSquare(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false
  const ratio = height / width
  // 560/380 ≈ 1.47. Tall workArea fill is often ≥2.2.
  return ratio <= 1.85
}
