export const NAV_SECTIONS = [
  {
    id: 'fleet',
    /** Empty: matte Operator rail is circle-only — no product wordmark in the nav. */
    label: '',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'realtime', label: 'Realtime' },
      { id: 'events', label: 'Events' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'notifications', label: 'Notifications' },
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
  | 'notifications'
  | 'keys'
  | 'settings'

export const NAV_IDS: NavId[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id))

/** OpenPanel / e-commerce leftovers. Fail loud if any remain in the rail or as a page. */
export const FORBIDDEN_NAV = [
  'scale',
  'change',
  'console',
  'seo',
  'pages',
  'insights',
  'profiles',
  'groups',
  'cohorts',
  'dashboards',
  'references'
] as const

export const EXTRA_PAGES = ['map'] as const
