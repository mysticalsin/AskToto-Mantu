/**
 * Vite resolve helper: if liquid-gooey is missing, serve a stub so the
 * renderer module graph still loads (girl clip / constellation / orbs).
 */
export const LIQUID_GOOEY_ID = 'liquid-gooey'
export const LIQUID_GOOEY_MISSING_ID = '\0virtual:liquid-gooey-missing'
export const LIQUID_GOOEY_STUB = 'export const Liquid = null\nexport default { Liquid: null }\n'

export function resolveOptionalLiquidGooey(id: string, installed: boolean): string | null {
  if (id !== LIQUID_GOOEY_ID) return null
  return installed ? null : LIQUID_GOOEY_MISSING_ID
}

export function loadOptionalLiquidGooeyStub(id: string): string | null {
  return id === LIQUID_GOOEY_MISSING_ID ? LIQUID_GOOEY_STUB : null
}
