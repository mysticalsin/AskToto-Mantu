/** Two-state theme toggle (light <-> dark), persisted to localStorage. */
import { paintShoeyMap } from './map'

function applyTheme(v: string | null): void {
  var theme = v === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', theme)
}

export function initTheme(): void {
  try {
    applyTheme(localStorage.getItem('metis-operator-theme') || 'light')
  } catch (e) {
    applyTheme('light')
  }
  paintShoeyMap()
  var themeBtn = document.getElementById('theme-btn')
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme')
      var next = cur === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      paintShoeyMap()
      try {
        localStorage.setItem('metis-operator-theme', next)
      } catch (e) {}
    })
  }
}
