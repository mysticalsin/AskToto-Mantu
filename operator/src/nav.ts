export const NAV_SECTIONS = [
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'realtime', label: 'Realtime' },
      { id: 'events', label: 'Events' },
      { id: 'sessions', label: 'Sessions' }
    ]
  },
  {
    id: 'fleet',
    label: 'Fleet',
    items: [
      { id: 'licenses', label: 'Licenses' },
      { id: 'notifications', label: 'Notifications' }
    ]
  },
  {
    id: 'ops',
    label: 'Ops',
    items: [
      { id: 'keys', label: 'Keys' },
      { id: 'settings', label: 'Settings' }
    ]
  }
] as const

export type NavId =
  | 'overview'
  | 'realtime'
  | 'events'
  | 'sessions'
  | 'licenses'
  | 'notifications'
  | 'keys'
  | 'settings'

export const NAV_IDS: NavId[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id))

export const FORBIDDEN_NAV = ['scale', 'change', 'console', 'dashboards', 'seo'] as const
