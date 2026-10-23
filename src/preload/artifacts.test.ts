import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_IPC } from '../shared/artifact'
import { createArtifactsPreloadApi } from './artifacts'

describe('artifacts preload bridge', () => {
  it('sends only ids, never a path', () => {
    const ipc = { invoke: vi.fn(), send: vi.fn() }
    const api = createArtifactsPreloadApi(ipc)
    void api.getTurnArtifacts('t1')
    void api.openArtifact('a1')
    void api.revealArtifact('a1')
    void api.armArtifactDrag('a1')
    api.startArtifactDrag('a1')
    expect(ipc.invoke).toHaveBeenCalledWith(ARTIFACT_IPC.forTurn, { turnId: 't1' })
    expect(ipc.invoke).toHaveBeenCalledWith(ARTIFACT_IPC.open, { artifactId: 'a1' })
    expect(ipc.invoke).toHaveBeenCalledWith(ARTIFACT_IPC.reveal, { artifactId: 'a1' })
    expect(ipc.invoke).toHaveBeenCalledWith(ARTIFACT_IPC.arm, { artifactId: 'a1' })
    expect(ipc.send).toHaveBeenCalledWith(ARTIFACT_IPC.dragStart, { artifactId: 'a1' })
  })
})
