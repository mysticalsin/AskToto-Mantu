/**
 * boot-window-rendering.ts — the boot window's QA-only rendering variants (M2-0516). The ST-1 window job
 * (qa-candidate.yml st1-mac-window) launches the packaged QA-identity build once per variant and chrome on one
 * runner and reads each launch's createWindow.construct cost, with the variant built, off its audit trail.
 *
 * Invariants:
 * - Outside the QA-identity build the variant is always 'shipped' and the environment is never read:
 *   QA_IDENTITY_BUILD is a compile-time literal, so shipping bytes carry neither the read nor the variable's name.
 * - 'shipped' sets no constructor option and prewarms nothing, so the shipped window is exactly createWindow's
 *   inline options.
 * - Every other variant changes one thing: one constructor option (spellcheck-off, paint-when-hidden), or one
 *   prewarm run once, in its own task ahead of the constructor's (prewarm-spellchecker; prewarm-view, a diagnostic).
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

/** What a prewarm variant runs ahead of the constructor. */
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

/** A yield before the boot window's constructor, so the constructor runs in a task of its own (M2-0422). Under a
 *  prewarm variant the first call also runs the prewarm, in a task of its own between the caller's and the
 *  constructor's; later calls only yield. A prewarm that throws goes to `fail` and boot goes on. */
export function bootWindowYield(
  variant: BootWindowVariant,
  prewarms: BootWindowPrewarms,
  yieldTask: () => Promise<void>,
  fail: (error: unknown) => void
): () => Promise<void> {
  let prewarm = variant === 'prewarm-spellchecker' ? prewarms.spellchecker : variant === 'prewarm-view' ? prewarms.view : null
  return async () => {
    const run = prewarm
    prewarm = null
    if (run) {
      await yieldTask()
      try {
        run()
      } catch (error) {
        fail(error)
      }
    }
    await yieldTask()
  }
}

export const yieldBeforeBootWindow = bootWindowYield(BOOT_WINDOW_VARIANT, ELECTRON_PREWARMS, yieldToEventLoop, (error) =>
  mainLog.warn('[boot] QA window prewarm failed:', error)
)
