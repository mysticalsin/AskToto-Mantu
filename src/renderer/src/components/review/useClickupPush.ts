import { useEffect, useRef, useState } from 'react'
import type { McpConnection } from '@shared/ipc'
import {
  clickupPayloadKey,
  clickupPushDone,
  markClickupPushed,
  seedClickupPushed,
  type CrmPayload,
  type CrmPushPhase
} from '../../lib/review-push-memory'
import { PUSH_FAILED_COPY } from './review-confirmations'

/**
 * MQA-092 / Q07 — a ClickUp push that landed before the meeting had a file yet. Same one-slot design and guard as
 * Review's CRM slot: the flush only writes when the fingerprint still matches the CURRENT payload, so a marker can
 * never land on a different meeting's file.
 */
let pendingClickupMarker: string | null = null

export type ClickupPushState = {
  phase: CrmPushPhase
  error: string | null
  destinationName?: string
  taskUrl?: string
}

const baseName = (path: string): string => path.split(/[/\\]/).pop() || path

/**
 * The ClickUp recap push: one task per meeting, named list, review-first. State lives here so Review stays small,
 * and a task that landed is remembered across a remount (module memory) and a relaunch (`clickup_pushed` marker),
 * so a second Confirm can never create a duplicate task in the team's tracker (D4-6).
 */
export function useClickupPush(args: {
  clickupConn: McpConnection | undefined
  savedPath: string | null | undefined
  confidentialFlag: boolean
  payload: CrmPayload
  clickupPushedKey: string | undefined
}) {
  const { clickupConn, savedPath, confidentialFlag, payload, clickupPushedKey } = args
  const [resolvedDest, setResolvedDest] = useState('')
  const [resolving, setResolving] = useState(false)
  const discoveringRef = useRef(false)
  const destName = (resolvedDest || clickupConn?.clickupListName || clickupConn?.clickupListId || '').trim()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ClickupPushState>({ phase: 'idle', error: null })
  useEffect(() => {
    setOpen(false)
    setState({ phase: 'idle', error: null })
    setResolvedDest('')
    setResolving(false)
    discoveringRef.current = false
  }, [savedPath])
  useEffect(() => {
    seedClickupPushed(clickupPushedKey)
  }, [clickupPushedKey])

  // Not just `state.phase === 'sent'`: that dies with the component, so a remount re-offered the push.
  const pushed = clickupPushDone(state.phase, payload)
  const fingerprint = clickupPayloadKey(payload)
  useEffect(() => {
    if (!savedPath || pendingClickupMarker !== fingerprint) return
    pendingClickupMarker = null
    void window.toto.recallSetPushMarker(baseName(savedPath), 'clickup_pushed', fingerprint).catch(() => {})
  }, [savedPath, fingerprint])

  const ensureDest = async (): Promise<void> => {
    if (!clickupConn) return
    if (destName || discoveringRef.current) return
    discoveringRef.current = true
    setResolving(true)
    try {
      const r = await window.toto.mcpClickupDiscoverDestination()
      const named = (r.clickupListName || r.clickupListId || '').trim()
      if (r.ok && named) {
        setResolvedDest(named)
        setState((s) =>
          s.phase === 'error' && /could not name the destination/i.test(s.error || '')
            ? { phase: 'idle', error: null }
            : s
        )
      } else {
        setState({ phase: 'error', error: r.error || 'ClickUp could not name the destination.' })
      }
    } finally {
      discoveringRef.current = false
      setResolving(false)
    }
  }

  const send = async (): Promise<void> => {
    if (state.phase === 'sending' || !clickupConn) return
    if (confidentialFlag) {
      setState({ phase: 'error', error: 'This meeting is marked confidential. ClickUp push is blocked.' })
      return
    }
    if (!destName) {
      setState({ phase: 'error', error: 'ClickUp could not name the destination.' })
      return
    }
    // The payload that was actually sent: the recap can move on while the call is in flight.
    const sent = payload
    const file = savedPath
    setState({ phase: 'sending', error: null })
    let r: Awaited<ReturnType<typeof window.toto.mcpPush>>
    try {
      r = await window.toto.mcpPush({
        connectionId: 'clickup',
        toolName: 'clickup_create_task',
        args: { name: sent.title, title: sent.title, description: sent.summary, confidential: confidentialFlag },
        ...(file ? { meetingFile: baseName(file) } : {})
      })
    } catch {
      // A rejected IPC must not leave the card on "Pushing…" with its in-flight guard blocking every retry.
      setState({ phase: 'error', error: PUSH_FAILED_COPY })
      return
    }
    if (!r.ok) {
      setState({ phase: 'error', error: r.error || 'ClickUp rejected the task.' })
      return
    }
    markClickupPushed(sent)
    // Best-effort durable half, like the CRM marker: the task already exists, so failing to record it is never
    // reported as a failed push. With no file yet, the marker is parked for the effect above.
    if (file)
      void window.toto.recallSetPushMarker(baseName(file), 'clickup_pushed', clickupPayloadKey(sent)).catch(() => {})
    else pendingClickupMarker = clickupPayloadKey(sent)
    setState({ phase: 'sent', error: null, destinationName: r.destinationName || destName, taskUrl: r.taskUrl })
  }

  return { open, setOpen, state, setState, destName, resolving, pushed, ensureDest, send }
}

export type ClickupPush = ReturnType<typeof useClickupPush>
