import { resolve } from 'node:path'

/** Entry name of the design-capture surface (src/renderer/design-capture.html). */
export const DESIGN_CAPTURE_ENTRY = 'design-capture'

/**
 * Renderer HTML entries Vite builds. The design-capture surface is a QA-only entry: it is emitted only when
 * the build sets METIS_DESIGN_CAPTURE=1 (the design-capture workflow), so a normal `npm run build` and every
 * installer built from it carry no trace of it. electron-builder's `files` lists exclude it a second time.
 */
export function rendererInputs(
  rendererRoot: string,
  env: Record<string, string | undefined>
): Record<string, string> {
  const inputs: Record<string, string> = {
    index: resolve(rendererRoot, 'index.html'),
    decoder: resolve(rendererRoot, 'decoder.html')
  }
  if (env.METIS_DESIGN_CAPTURE === '1') {
    inputs[DESIGN_CAPTURE_ENTRY] = resolve(rendererRoot, `${DESIGN_CAPTURE_ENTRY}.html`)
  }
  return inputs
}
