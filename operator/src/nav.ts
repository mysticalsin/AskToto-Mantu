export const NAV_SECTIONS = [
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'realtime', label: 'Realtime' },
      { id: 'events', label: 'Events' },
      { id: 'profiles', label: 'Profiles' },
      { id: 'map', label: 'Map' }
    ]
  },
  {
    id: 'fleet',
    label: 'Fleet',
    items: [
      { id: 'macos', label: 'macOS' },
      { id: 'windows', label: 'Windows' },
      { id: 'licenses', label: 'Licenses' }
    ]
  },
  {
    id: 'ops',
    label: 'Ops',
    items: [
      { id: 'skills', label: 'Skills' },
      { id: 'keys', label: 'Keys' }
    ]
  }
] as const

export type NavId =
  | 'overview'
  | 'realtime'
  | 'events'
  | 'profiles'
  | 'map'
  | 'macos'
  | 'windows'
  | 'licenses'
  | 'skills'
  | 'keys'

export const NAV_IDS: NavId[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id))

export const FORBIDDEN_NAV = [
  'scale',
  'change',
  'console',
  'pages',
  'seo',
  'groups',
  'cohorts',
  'dashboards',
  'insights',
  'reports'
] as const
