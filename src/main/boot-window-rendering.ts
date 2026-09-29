import { performance } from 'node:perf_hooks'
import { BOOT_WINDOW_VARIANTS, type BootWindowVariant } from './infra/observability/projection'
import type { RunObservability } from './infra/observability/run-observability'

/** The boot window's rendering options that ST-1 measures the native constructor under (M2-0433). */
export interface BootWindowRendering {
  variant: BootWindowVariant
  paintWhenInitiallyHidden: boolean
  backgroundThrottling: boolean
}

/** The QA-only variable the ST-1 window job sets to measure one rendering variant per launch. */
export const QA_WINDOW_VARIANT_ENV = 'ASKTOTO_QA_WINDOW_VARIANT'

/** The shipped configuration: the hidden boot window paints its first frame in the show task, not the
 *  constructor's (M2-0031), and the overlay's timers are never throttled while it is hidden or occluded. */
const SHIPPED: BootWindowRendering = { variant: 'shipped', paintWhenInitiallyHidden: false, backgroundThrottling: false }

/** The rendering options for `value` (the QA variable's value). Anything but a known variant name, unset
 *  included, is the shipped configuration; each variant changes exactly one option from it. */
export function bootWindowRendering(value: string | undefined): BootWindowRendering {
  const variant = BOOT_WINDOW_VARIANTS.find((name) => name === value) ?? 'shipped'
  switch (variant) {
    case 'paint-when-hidden':
      return { ...SHIPPED, variant, paintWhenInitiallyHidden: true }
    case 'background-throttling':
      return { ...SHIPPED, variant, backgroundThrottling: true }
    case 'shipped':
      return SHIPPED
  }
}

/** Runs the boot window's native constructor under the rendering options for `variantValue` and audits its own
 *  cost as `createWindow.construct`, with the chrome and variant it built, so every ST-1 report names what was
 *  constructed. The audit write is outside the measured time; a constructor that throws records nothing. */
export function constructBootWindow<W>(
  observability: Pick<RunObservability, 'recordBootStage'> | null,
  transparent: boolean,
  construct: (rendering: BootWindowRendering) => W,
  variantValue: string | undefined = process.env[QA_WINDOW_VARIANT_ENV],
  now: () => number = () => performance.now()
): W {
  const rendering = bootWindowRendering(variantValue)
  const started = now()
  const built = construct(rendering)
  observability?.recordBootStage('createWindow.construct', now() - started, { transparent, windowVariant: rendering.variant })
  return built
}
