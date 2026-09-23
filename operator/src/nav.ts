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
    // Reference sidebar "Manage" section (operator/shoey-ref/SPEC.md): notifications and
    // settings first, then the fleet (licenses, groups) and ops (keys, connectors, audit) pages.
    id: 'manage',
    label: 'Manage',
    items: [
      { id: 'notifications', label: 'Notifications' },
      { id: 'settings', label: 'Settings' },
      { id: 'licenses', label: 'Licenses' },
      { id: 'groups', label: 'Groups' },
      { id: 'keys', label: 'Keys' },
      { id: 'connectors', label: 'Connectors' },
      { id: 'audit', label: 'Audit' }
    ]
  }
] as const

export type NavId =
  | 'overview'
  | 'realtime'
  | 'events'
  | 'sessions'
  | 'licenses'
  | 'groups'
  | 'notifications'
  | 'keys'
  | 'connectors'
  | 'audit'
  | 'settings'

export const NAV_IDS: NavId[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id))

export const FORBIDDEN_NAV = ['scale', 'change', 'console', 'dashboards', 'seo'] as const
