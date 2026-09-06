export const NAV_SECTIONS = [
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'realtime', label: 'Realtime' },
      { id: 'events', label: 'Events' },
      { id: 'map', label: 'Map' }
    ]
  },
  {
    id: 'fleet',
    label: 'Fleet',
    items: [
      { id: 'profiles', label: 'Users' },
      { id: 'macos', label: 'macOS' },
      { id: 'windows', label: 'Windows' },
      { id: 'licenses', label: 'Licenses' }
    ]
  },
  {
    id: 'ops',
    label: 'Ops',
    items: [
      { id: 'keys', label: 'Keys' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'rules', label: 'Rules' },
      { id: 'pushes', label: 'Pushes' },
      { id: 'skills', label: 'Skills' }
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
  | 'notifications'
  | 'rules'
  | 'pushes'

export const NAV_IDS: NavId[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id))

export const FORBIDDEN_NAV = ['scale', 'change', 'console', 'sessions'] as const
