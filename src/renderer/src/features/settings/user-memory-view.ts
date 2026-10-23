import type { UserMemoryItem } from '@shared/user-memory'

const DAY_MS = 86_400_000

/** The row's second line: what kind it is, where it came from and when it ends. Pure, so it is tested on its own. */
export function userMemoryDetail(item: UserMemoryItem, now: number): string {
  const said =
    item.source === 'owner-spoken'
      ? 'You said this'
      : item.source === 'settings'
        ? 'Set in Settings'
        : item.source === 'derived'
          ? 'Noticed in your work'
          : 'You typed this'
  if (item.kind === 'preference') return `${said}. Kept until you remove it.`
  const days = item.expiresAt === null ? null : Math.max(0, Math.ceil((item.expiresAt - now) / DAY_MS))
  const from = item.conversation ? ` From ${item.conversation}.` : ''
  return `${said}.${from} ${days === null ? '' : `Forgotten in ${days} day${days === 1 ? '' : 's'} unless used again.`}`.trim()
}
