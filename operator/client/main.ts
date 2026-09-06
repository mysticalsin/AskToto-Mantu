/**
 * Métis Operator SPA entry point. Bundled by operator/scripts/build-client.mjs into
 * operator/src/spa/client.generated.ts (CONSOLE_JS), served hashed at
 * /assets/operator-<hash>.js and aliased at /assets/index.js. No framework, no dependencies.
 */
import { esc } from '../src/render'
import { initRouter } from './router'
import { initTheme } from './theme'
import { initGeoCountryFilter } from './map'
import {
  initVolumeTabs,
  initVolumeSearch,
  initEventsFilters,
  initEvTabs,
  initNtTabs,
  initSessionsFilter,
  initNtFilter,
  initScaleButtons,
  initCrmFilter
} from './filters'
import { initSeatOverlay, initSkillActions, initCrmRetry, initKeyForms } from './actions'

;(function metisOperatorSpa() {
  'use strict'
  var pages = ['overview', 'realtime', 'events', 'sessions', 'notifications', 'keys', 'settings']
  ;(self as any).METIS_OPERATOR_SPA = {
    chrome: 'shoey',
    product: 'Métis Operator',
    pages: pages,
    nav: pages,
    hydrate: 'post-access'
  }

  // Shared render path sanity check: esc() is the same helper the Worker uses for first
  // paint (operator/src/render). Fail loud if the two builds ever disagree on it.
  if (esc('&') !== '&amp;') throw new Error('Métis Operator SPA: shared render path esc() mismatch')

  initRouter()
  initVolumeTabs()
  initVolumeSearch()
  initEventsFilters()
  initEvTabs()
  initNtTabs()
  initSessionsFilter()
  initNtFilter()
  initTheme()
  initSeatOverlay()
  initScaleButtons()
  initGeoCountryFilter()
  initCrmFilter()
  initSkillActions()
  initKeyForms()
  initCrmRetry()
})()
