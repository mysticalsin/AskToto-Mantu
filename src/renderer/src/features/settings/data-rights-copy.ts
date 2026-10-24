import type { ErasureReceipt, PreviewResult } from '@shared/data-rights'
import type { ConfirmActionInput } from '../../lib/navigation-guard'

/** What the person is told about each closed code a receipt can carry. No path, no error text: only these sentences. */
const EXCEPTION_COPY: Readonly<Record<string, string>> = {
  'cloud-sync-recycle-bin':
    'Copies kept by OneDrive or your other devices are outside Métis. Empty the OneDrive recycle bin and delete them on your other devices.',
  'operator-endpoint-missing':
    "Records your organisation keeps are not removed from here. Ask your organisation's administrator to delete them.",
  'memory-server-owner-delete-missing': 'Some memory held outside this device could not be removed from here yet.',
  'audit-chain-integrity': 'The security log is kept. It records that something happened, never what it contained.',
  'proof-of-erasure': 'This receipt is kept as proof of what was erased.',
  'recognise-owner-and-keep-fence': 'A small record that this account was erased is kept so nothing comes back.',
  'reset-is-profile-recovery': 'Settings are kept. Use Reset to archive them.',
  'no-eraser': 'Métis could not erase this part.',
  'erase-failed': 'Métis could not erase this part.',
  'still-present': 'Some of this was still there after erasing.',
  'fence-write-failed': 'Nothing was erased, because Métis could not record the erasure safely.'
}

export const exceptionText = (code: string): string => EXCEPTION_COPY[code] ?? 'Not removed.'

/** The confirm card for the erase action. Counts and labels only. */
export function erasureConfirmation(preview: Extract<PreviewResult, { ok: true }>): ConfirmActionInput {
  const meetings = preview.items.find((item) => item.store === 'meetings')?.count
  const what =
    meetings === undefined
      ? 'every saved meeting, note, memory, assistant and cache'
      : `${meetings} saved meeting${meetings === 1 ? '' : 's'}, plus every note, memory, assistant and cache`
  return {
    title: 'Erase all my Métis data?',
    message: `Métis will permanently remove ${what} for this account from this device. It cannot be undone. Copies kept in the cloud or on other devices are not removed.`,
    confirmLabel: 'Erase Everything',
    destructive: true
  }
}

export function refusalText(reason: string): string {
  switch (reason) {
    case 'meeting-recording':
      return 'Stop the meeting that is recording first.'
    case 'busy':
      return 'An erasure is already running.'
    case 'expired':
      return 'That took too long. Try again.'
    case 'signed-out':
      return 'Sign in first.'
    default:
      return "Couldn't do that. Try again."
  }
}

export function receiptSummary(receipt: ErasureReceipt): { headline: string; notes: string[] } {
  const erased = receipt.stores.filter((s) => s.outcome === 'erased').length
  const notes = [...new Set(receipt.exceptions.map((e) => exceptionText(e.code)))]
  const places = `${erased} place${erased === 1 ? '' : 's'}`
  return {
    headline:
      receipt.failed > 0
        ? `Erased ${places}; ${receipt.failed} could not be erased.`
        : `Erased ${places}. Nothing failed.`,
    notes
  }
}
