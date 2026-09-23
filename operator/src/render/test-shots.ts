import type { Page } from 'playwright'

/**
 * Screenshot helper for the Playwright layout and interaction tests (operator UX Rock 1).
 *
 * When OPERATOR_SHOTS_DIR is set, writes `<dir>/<name>-<width>x<height>.png` for the page's
 * current viewport so a reviewer can compare every layout against the reference captures. When
 * it is unset nothing is written and the test runs exactly as before. `legacyEnv` keeps an older
 * per-test variable working (overview.layout.test.ts: METIS_OVERVIEW_SCREENSHOT*): if that
 * variable names a file path, the same screenshot is also written there.
 *
 * Deliberately free of node:* imports and the `process` global type: this file sits under
 * operator/src, which the Worker tsconfig (lib WebWorker, types []) typechecks. Playwright's
 * `screenshot({ path })` creates missing parent directories itself.
 */
function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[name]
  return value ? value : undefined
}

export async function shoot(
  page: Page,
  name: string,
  opts: { fullPage?: boolean; legacyEnv?: string } = {}
): Promise<string | null> {
  const fullPage = opts.fullPage ?? true
  const dir = env('OPERATOR_SHOTS_DIR')
  const legacyPath = opts.legacyEnv ? env(opts.legacyEnv) : undefined
  let written: string | null = null
  if (dir) {
    const size = page.viewportSize() ?? { width: 0, height: 0 }
    const file = `${dir.replace(/\/+$/, '')}/${name}-${size.width}x${size.height}.png`
    await page.screenshot({ path: file, fullPage })
    written = file
  }
  if (legacyPath) {
    await page.screenshot({ path: legacyPath, fullPage })
    written = written ?? legacyPath
  }
  return written
}
