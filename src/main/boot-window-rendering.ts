/**
 * boot-window-rendering.ts — the boot window's prewarm and its QA-only rendering variants (M2-0516, M2-0519). The
 * ST-1 window job (qa-candidate.yml st1-mac-window) launches the packaged QA-identity build once per variant and
 * chrome on one runner and reads each launch's createWindow.prewarm and createWindow.construct cost, with the variant
 * built, off its audit trail.
 *
 * Invariants:
 * - Outside the QA-identity build the variant is always 'shipped' and the environment is never read:
 *   QA_IDENTITY_BUILD is a compile-time literal, so shipping bytes carry neither the read nor the variable's name.
 * - 'shipped' sets no constructor option, so the shipped window is exactly createWindow's inline options, and it
 *   prewarms one bare web contents once, in a task of its own ahead of the constructor's (M2-0519: the measured
 *   option that kept createWindow.construct under 250 ms in both chromes).
 * - Every other variant changes one thing from 'shipped': one constructor option (spellcheck-off,
 *   paint-when-hidden), or the prewarm it runs (prewarm-spellchecker).
 */
import { WebContentsView, session } from 'electron'
import { yieldToEventLoop } from './boot-tray'
import { BOOT_WINDOW_VARIANTS, type BootWindowVariant } from './infra/observability/projection'
import { mainLog } from './logger'
import { QA_IDENTITY_BUILD } from './qa-identity'

/** The variant a QA variable value names; anything else, unset included, is 'shipped'. */
export function bootWindowVariant(value: string | undefined): BootWindowVariant {
  return BOOT_WINDOW_VARIANTS.find((name) => name === value) ?? 'shipped'
}

/** The variant this launch builds its boot window under. */
export const BOOT_WINDOW_VARIANT: BootWindowVariant = QA_IDENTITY_BUILD
  ? bootWindowVariant(process.env.METIS_QA_WINDOW_VARIANT)
  : 'shipped'

/** The option values a variant sets over createWindow's inline constructor options (spread after them). */
export interface BootWindowOptions {
  window: { paintWhenInitiallyHidden?: boolean }
  webPreferences: { spellcheck?: boolean }
}

export function bootWindowOptions(variant: BootWindowVariant): BootWindowOptions {
  switch (variant) {
    case 'spellcheck-off':
      return { window: {}, webPreferences: { spellcheck: false } }
    case 'paint-when-hidden':
      return { window: { paintWhenInitiallyHidden: true }, webPreferences: {} }
    default:
      return { window: {}, webPreferences: {} }
  }
}

/** The option values this launch's boot window is built with: none in every shipping build. */
export const BOOT_WINDOW_OPTIONS: BootWindowOptions = bootWindowOptions(BOOT_WINDOW_VARIANT)

/** What a variant can run ahead of the constructor. */
export interface BootWindowPrewarms {
  spellchecker(): void
  view(): void
}

const ELECTRON_PREWARMS: BootWindowPrewarms = {
  // Creates the default session's spellcheck service, which the first web contents otherwise creates inside the
  // window constructor. The word list is dropped unread.
  spellchecker: () => void session.defaultSession.listWordsInSpellCheckerDictionary().catch(() => undefined),
  // Builds and closes one bare, never-navigated web contents, so a first-web-contents cost moves out of the constructor.
  view: () => new WebContentsView().webContents.close()
}

/** A yield before the boot window's constructor, so the constructor runs in a task of its own (M2-0422). The first
 *  call also runs the variant's prewarm, in a task of its own between the caller's and the constructor's, and
 *  hands its duration, thrown or not, to `measured`; later calls only yield. A prewarm that throws goes to `fail`
 *  and boot goes on. */
export function bootWindowYield(
  variant: BootWindowVariant,
  prewarms: BootWindowPrewarms,
  yieldTask: () => Promise<void>,
  fail: (error: unknown) => void,
  measured: (ms: number) => void = () => undefined,
  now: () => number = () => performance.now()
): () => Promise<void> {
  let prewarm: (() => void) | null = variant === 'prewarm-spellchecker' ? prewarms.spellchecker : prewarms.view
  return async () => {
    const run = prewarm
    prewarm = null
    if (run) {
      await yieldTask()
      const startedMs = now()
      try {
        run()
      } catch (error) {
        fail(error)
      }
      measured(now() - startedMs)
    }
    await yieldTask()
  }
}

let prewarmMs: number | null = null

export const yieldBeforeBootWindow = bootWindowYield(
  BOOT_WINDOW_VARIANT,
  ELECTRON_PREWARMS,
  yieldToEventLoop,
  (error) => mainLog.warn('[boot] window prewarm failed:', error),
  (ms) => {
    prewarmMs = ms
  }
)

/** The boot window prewarm's duration, once: null before it ran and after it was taken. The prewarm runs before
 *  createWindow starts run observability, so createWindow takes it and records it as a boot stage. */
export function takeBootWindowPrewarmMs(): number | null {
  const ms = prewarmMs
  prewarmMs = null
  return ms
}
