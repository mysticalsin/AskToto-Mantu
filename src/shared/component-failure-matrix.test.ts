import { describe, expect, it } from 'vitest'
import { OptionalComponentStatusSchema, SpeechPackComponentSnapshotSchema } from './speech-pack'
import {
  APPLICABLE_FAILURE_MODES,
  BLOCKED_BY_FAILURE_MODE,
  COMPONENT_FAILURE_MATRIX,
  FailureModeSchema,
  LOCAL_MODEL_REASON_FAILURE_MODE,
  MatrixComponentIdSchema,
  NON_REMOVABLE_COMPONENTS,
  SPEECH_ROW_STATE_FAILURE_MODE,
  matrixRowFor
} from './component-failure-matrix'

const componentIds = MatrixComponentIdSchema.options
const modes = new Set<string>(FailureModeSchema.options)

describe('optional component failure matrix (G87)', () => {
  it('every component has a row for every applicable failure mode', () => {
    for (const id of componentIds) {
      for (const mode of APPLICABLE_FAILURE_MODES[id]) {
        const row = matrixRowFor(id, mode)
        expect(row, `${id}/${mode}`).not.toBeNull()
        expect(row?.copy.length).toBeGreaterThan(0)
        expect(row?.copy.length).toBeLessThanOrEqual(160)
      }
      const rows = COMPONENT_FAILURE_MATRIX.filter((item) => item.component === id)
      expect(rows.map((item) => item.mode).sort()).toEqual([...APPLICABLE_FAILURE_MODES[id]].sort())
    }
  })

  it('every blockedBy value maps to a failure mode', () => {
    const blockedBy = OptionalComponentStatusSchema.shape.blockedBy.unwrap().options
    expect(Object.keys(BLOCKED_BY_FAILURE_MODE).sort()).toEqual([...blockedBy].sort())
    for (const value of blockedBy) expect(modes.has(BLOCKED_BY_FAILURE_MODE[value])).toBe(true)
  })

  it('every speech-pack row state is either a failure mode or explicitly healthy', () => {
    const states = SpeechPackComponentSnapshotSchema.shape.state.options
    expect(Object.keys(SPEECH_ROW_STATE_FAILURE_MODE).sort()).toEqual([...states].sort())
    for (const state of states) {
      const mode = SPEECH_ROW_STATE_FAILURE_MODE[state]
      expect(mode === null || modes.has(mode)).toBe(true)
    }
  })

  it('every LocalModelUnavailableReason except downloading/not-downloaded maps to a failure mode', () => {
    const reasons = [
      'invalid-bundle',
      'insufficient-ram',
      'insufficient-disk',
      'downloading',
      'download-failed',
      'not-downloaded'
    ] as const
    expect(Object.keys(LOCAL_MODEL_REASON_FAILURE_MODE).sort()).toEqual([...reasons].sort())
    for (const reason of reasons) {
      const mode = LOCAL_MODEL_REASON_FAILURE_MODE[reason]
      if (reason === 'downloading' || reason === 'not-downloaded') expect(mode).toBeNull()
      else expect(modes.has(mode as string)).toBe(true)
    }
  })

  it('non-removable rows declare provider and privacy and are never removable', () => {
    expect(NON_REMOVABLE_COMPONENTS.map((item) => item.id).sort()).toEqual([
      'mac-helper',
      'mcp-servers',
      'system-voices'
    ])
    for (const item of NON_REMOVABLE_COMPONENTS) {
      expect(item.removable).toBe(false)
      expect(item.provider.length).toBeGreaterThan(0)
      expect(item.privacyNote.length).toBeGreaterThan(0)
      for (const failure of item.failures) expect(failure.seam.length).toBeGreaterThan(0)
    }
  })
})
