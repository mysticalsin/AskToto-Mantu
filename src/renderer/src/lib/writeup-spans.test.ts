import { describe, expect, it, vi } from 'vitest'
import { UNAUTHENTICATED_RESULT } from '@shared/ipc-auth'
import { IPC_UNAUTHENTICATED_EVENT } from './ipc-auth'
import { installIpcAuthTestWindow } from './ipc-auth-test-window'
import { reportWriteupSpan } from './writeup-spans'

describe('reportWriteupSpan', () => {
  it('routes the migrated write-up reporter through the shared unauthenticated handler', async () => {
    const events = installIpcAuthTestWindow()
    window.addEventListener(IPC_UNAUTHENTICATED_EVENT, (event) => events.push(event))
    const reportWriteupSpanIpc = vi.fn().mockResolvedValue(UNAUTHENTICATED_RESULT)
    window.toto = { ...window.toto, reportWriteupSpan: reportWriteupSpanIpc }

    reportWriteupSpan({ span: 'stop_to_recap_done', ms: 10 })
    await Promise.resolve()

    expect(reportWriteupSpanIpc).toHaveBeenCalledWith({ span: 'stop_to_recap_done', ms: 10 })
    expect((events[0] as CustomEvent).detail).toEqual(UNAUTHENTICATED_RESULT)
  })
})
