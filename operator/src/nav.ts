export const NAV_SECTIONS = [
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'dashboards', label: 'Dashboards' },
      { id: 'insights', label: 'Insights' },
      { id: 'pages', label: 'Pages' },
      { id: 'seo', label: 'SEO' },
      { id: 'realtime', label: 'Realtime' },
      { id: 'events', label: 'Events' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'profiles', label: 'Profiles' },
      { id: 'groups', label: 'Groups' },
      { id: 'cohorts', label: 'Cohorts' }
    ]
  },
  {
    id: 'manage',
    label: 'Manage',
    items: [
      { id: 'settings', label: 'Settings' },
      { id: 'references', label: 'References' },
      { id: 'notifications', label: 'Notifications' }
    ]
  }
] as const

export type NavId =
  | 'overview'
  | 'dashboards'
  | 'insights'
  | 'pages'
  | 'seo'
  | 'realtime'
  | 'events'
  | 'sessions'
  | 'profiles'
  | 'groups'
  | 'cohorts'
  | 'settings'
  | 'references'
  | 'notifications'

export const NAV_IDS: NavId[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id))

export const FORBIDDEN_NAV = ['scale', 'change', 'console'] as const

export const EXTRA_PAGES = [
  'keys',
  'licenses',
  'devices',
  'map',
  'skills',
  'macos',
  'windows',
  'cloudflare'
] as const
