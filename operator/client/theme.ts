/**
 * Three-state theme toggle (System / Light / Dark), matching the reference's `[data-theme]`
 * contract in operator/src/spa/css.ts. "System" removes `data-theme` so the CSS
 * `prefers-color-scheme` media queries decide. Persisted to `localStorage` (immediate, this
 * tab) and mirrored to a `metis-operator-theme` cookie (SameSite=Lax) so the NEXT server
 * render picks the same theme with no flash (renderConsole reads the cookie server-side).
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

function readStoredTheme(): ThemeChoice {
  try {
    var v = localStorage.getItem('metis-operator-theme')
    if (isThemeChoice(v)) return v
  } catch (e) {}
  return 'system'
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
