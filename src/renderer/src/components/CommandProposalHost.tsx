import { useCallback, useEffect, useRef, useState } from 'react'
import { commandResultCopy } from '@shared/command-copy'
import type { MetisCommandNotice, MetisCommandPreview, MetisCommandState } from '@shared/metis-command-contract'
import { AccountChoiceHost } from './AccountChoiceHost'
import { CommandProposalCard } from './CommandProposalCard'

type Line = { text: string; settingsKind?: MetisCommandNotice['settingsKind'] }

/** How long an honest sentence stays up when nothing needs the person's attention. */
const LINE_MS = 8_000

/**
 * Hosts the voice-action confirmation surface: the card for the proposal main published, then the sentence that
 * tells the person what happened (done, couldn't confirm, timed out), plus honest copy for a command that could not
 * start and the once-only boot recovery notices. Every decision goes through main, which owns the nonce, the args
 * hash and the lifetime; this component holds none of that authority. Opus owns the final visual design (V05).
 */
export function CommandProposalHost({ state }: { state: MetisCommandState }): JSX.Element | null {
  const [line, setLine] = useState<Line | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((next: Line | null) => {
    if (timer.current) clearTimeout(timer.current)
    setLine(next)
    if (next) timer.current = setTimeout(() => setLine(null), LINE_MS)
  }, [])

  useEffect(() => {
    const off = window.toto.onMetisCommandNotice((notice) =>
      show({ text: notice.copy, settingsKind: notice.settingsKind })
    )
    void window.toto
      .takeMetisCommandRecoveryNotices()
      .then((notices) => {
        if (notices.length > 0) show({ text: notices.map((notice) => notice.copy).join(' ') })
      })
      .catch(() => undefined)
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [show])

  const decide = useCallback(
    async (confirm: boolean, proposal: Extract<MetisCommandState, { proposalId: string }>) => {
      const preview: MetisCommandPreview = proposal.preview
      try {
        if (confirm) {
          const result = await window.toto.confirmMetisCommand({
            proposalId: proposal.proposalId,
            nonce: proposal.nonce,
            argsHash: proposal.argsHash
          })
          const copy = commandResultCopy(result.ok ? { ok: true } : { ok: false, reason: result.reason }, preview)
          show(copy ? { text: copy } : null)
        } else {
          await window.toto.cancelMetisCommand({ proposalId: proposal.proposalId, nonce: proposal.nonce })
          show({ text: 'Cancelled. Nothing was done.' })
        }
      } catch {
        show({ text: "Métis can't do this right now." })
      }
    },
    [show]
  )

  const settingsKind = line?.settingsKind
  return (
    <>
      <AccountChoiceHost onNotice={(text) => show({ text })} />
      {state.proposalId ? (
        <CommandProposalCard
          key={state.proposalId}
          proposal={state}
          onConfirm={() => void decide(true, state)}
          onCancel={() => void decide(false, state)}
        />
      ) : null}
      {line ? (
        <div className="pointer-events-auto absolute inset-x-4 bottom-3 z-[89]" data-metis-command-line="1">
          <p
            role="status"
            className="glass-strong m-0 rounded-xl border border-white/15 px-3 py-2 text-[12px] text-[color:var(--color-ink)]"
          >
            {line.text}
            {settingsKind ? (
              <button
                type="button"
                className="no-drag focus-ring ml-2 underline"
                onClick={() => void window.toto.openPermissionSettings(settingsKind)}
              >
                Open System Settings
              </button>
            ) : null}
          </p>
        </div>
      ) : null}
    </>
  )
}
