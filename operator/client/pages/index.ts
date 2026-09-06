/**
 * Maps a nav id to its page's client init function (plan P0.4 prep, dev-shell). One file per
 * page under operator/client/pages/ so the section-wave builders (P1) never share a file: each
 * owns exactly one `<page>.ts` here, plus their operator/src/render/pages/<page>.ts and
 * operator/src/spa/css-<page>.ts. operator/client/main.ts's boot sequence and `rerender()` both
 * call `PAGE_INIT[page]?.(section, data)` right after `bindMotion(section)`.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { initOverview } from './overview'
import { initRealtime } from './realtime'
import { initEvents } from './events'
import { initSessions } from './sessions'
import { initLicenses } from './licenses'
import { initGroups } from './groups'
import { initNotifications } from './notifications'
import { initKeys } from './keys'
import { initConnectors } from './connectors'
import { initAudit } from './audit'
import { initSettings } from './settings'

export type PageInit = (section: HTMLElement, data: DashboardPayload | null) => void

export const PAGE_INIT: Record<string, PageInit> = {
  overview: initOverview,
  realtime: initRealtime,
  events: initEvents,
  sessions: initSessions,
  licenses: initLicenses,
  groups: initGroups,
  notifications: initNotifications,
  keys: initKeys,
  connectors: initConnectors,
  audit: initAudit,
  settings: initSettings
}
