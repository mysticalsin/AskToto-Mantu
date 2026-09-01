/** Métis Operator StatusBadge. shadcn-style API, Métis glass chrome. No StatusDemo. No orange-50. */

export const STATUS_BADGE_STATES = [
  'pending',
  'in_progress',
  'in_review',
  'submitted',
  'success',
  'failed',
  'expired'
] as const

export type StatusBadgeState = (typeof STATUS_BADGE_STATES)[number]

export const STATUS_BADGE_LABEL: Record<StatusBadgeState, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  in_review: 'In review',
  submitted: 'Submitted',
  success: 'Success',
  failed: 'Failed',
  expired: 'Expired'
}

/** Lucide 24x24 paths (MIT). TriangleAlert, CircleX, CircleCheck, CircleDashed, ScanSearch, Clock5. */
const ICONS: Record<StatusBadgeState, string> = {
  pending:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  failed:
    '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  success:
    '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  in_progress:
    '<circle cx="12" cy="12" r="10" stroke-dasharray="4 4"/>',
  in_review:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16 1.5 1.5"/>',
  expired:
    '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l3 2"/>',
  submitted:
    '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'
}

const ALIAS: Record<string, StatusBadgeState> = {
  pending: 'pending',
  failed: 'failed',
  success: 'success',
  expired: 'expired',
  submitted: 'submitted',
  'in-progress': 'in_progress',
  in_progress: 'in_progress',
  'in-review': 'in_review',
  in_review: 'in_review',
  'dead-letter': 'expired',
  dead_letter: 'expired'
}

export function asStatusBadgeState(raw: unknown): StatusBadgeState | null {
  if (typeof raw !== 'string') return null
  return ALIAS[raw.trim().toLowerCase()] ?? null
}

export function statusBadge(state: StatusBadgeState | string, opts?: { label?: string }): string {
  const resolved = asStatusBadgeState(state)
  if (!resolved) return ''
  const label = opts?.label ?? STATUS_BADGE_LABEL[resolved]
  return `<span class="status-badge status-${resolved}" data-status="${resolved}">
    <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[resolved]}</svg>
    <span>${escapeHtml(label)}</span>
  </span>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

export const STATUS_BADGE_CSS = `
.status-badge {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--hair); border-radius: 999px;
  padding: 2px 8px 2px 6px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ink2); background: rgba(255,255,255,0.03);
}
.status-icon { width: 11px; height: 11px; flex: 0 0 auto; }
.status-pending { color: #e4c36a; border-color: rgba(228,195,106,0.28); }
.status-failed { color: var(--danger); border-color: rgba(240,113,122,0.28); }
.status-success { color: var(--ok); border-color: rgba(131,192,146,0.28); }
.status-in_progress { color: #7dd3fc; border-color: rgba(125,211,252,0.28); }
.status-in_review { color: #facc15; border-color: rgba(250,204,21,0.28); }
.status-expired { color: #a1a1aa; border-color: rgba(161,161,170,0.28); }
.status-submitted { color: var(--accent); border-color: rgba(124,140,248,0.28); }
.tab.on .status-badge { background: rgba(10,10,11,0.06); }
`
