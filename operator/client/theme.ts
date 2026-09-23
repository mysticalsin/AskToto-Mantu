/**
 * Three-state theme toggle (System / Light / Dark), matching the reference's `[data-theme]`
 * contract in operator/src/spa/css.ts. "System" removes `data-theme` so the CSS
 * `prefers-color-scheme` media queries decide. Persisted to `localStorage` (immediate, this
 * tab) and mirrored to a `metis-operator-theme` cookie (SameSite=Lax) so the NEXT server
 * render picks the same theme with no flash (renderConsole reads the cookie server-side). When
 * this browser profile has no localStorage value yet, the client falls back to whatever the
 * server already rendered (`data-theme` on `<html>`) instead of resetting to System, so the
 * segmented control's `aria-pressed` state always agrees with what is on screen.
 */
import { paintShoeyMap } from './map'

export type ThemeChoice = 'system' | 'light' | 'dark'

function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || v === 'light' || v === 'dark'
}

function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', choice)
  }
  document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(function (btn) {
    btn.setAttribute('aria-pressed', btn.getAttribute('data-theme-choice') === choice ? 'true' : 'false')
  })
}

function persistTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem('metis-operator-theme', choice)
  } catch (e) {}
  try {
    document.cookie = 'metis-operator-theme=' + choice + '; path=/; max-age=31536000; SameSite=Lax'
  } catch (e) {}
}

/** What the server already rendered (the `metis-operator-theme` cookie, read server-side into
 * `ctx.theme` and printed as `data-theme` on `<html>`, or its absence for 'system'). Used as the
 * fallback when this browser profile has no localStorage value yet (a fresh profile, a QA/preview
 * harness, a cleared site data run with the cookie still present) so the segmented control and
 * the page agree with what is already on screen instead of silently resetting to System. */
function readServerTheme(): ThemeChoice {
  var attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' || attr === 'dark' ? attr : 'system'
}

function readStoredTheme(): ThemeChoice {
  try {
    var v = localStorage.getItem('metis-operator-theme')
    if (isThemeChoice(v)) return v
  } catch (e) {}
  return readServerTheme()
}

export function initTheme(): void {
  applyTheme(readStoredTheme())
  paintShoeyMap()
  document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var choice = btn.getAttribute('data-theme-choice')
      if (!isThemeChoice(choice)) return
      applyTheme(choice)
      persistTheme(choice)
      paintShoeyMap()
    })
  })
}
