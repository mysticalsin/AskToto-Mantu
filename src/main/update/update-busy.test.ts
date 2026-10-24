import { describe, expect, it } from 'vitest'
import { updateBusyReasons, type UpdateBusyInput } from './update-busy'

const IDLE: UpdateBusyInput = {
  meetingReserved: false,
  captureActive: false,
  leasePurpose: null,
  taskStatuses: [],
  importStates: []
}

describe('G86 updateBusyReasons — when an install must wait', () => {
  it('is empty when everything is idle', () => {
    expect(updateBusyReasons(IDLE)).toEqual([])
  })

  it('reports a meeting reservation as meeting', () => {
    expect(updateBusyReasons({ ...IDLE, meetingReserved: true })).toEqual(['meeting'])
  })

  it('reports any live capture flag as meeting, once', () => {
    expect(updateBusyReasons({ ...IDLE, captureActive: true, meetingReserved: true })).toEqual(['meeting'])
  })

  it('reports a dictation lease as dictation', () => {
    expect(updateBusyReasons({ ...IDLE, leasePurpose: 'dictation' })).toEqual(['dictation'])
  })

  it('reports a command lease as conversation', () => {
    expect(updateBusyReasons({ ...IDLE, leasePurpose: 'command' })).toEqual(['conversation'])
  })

  it('reports dispatching and uncertain tasks as task', () => {
    expect(updateBusyReasons({ ...IDLE, taskStatuses: ['completed', 'dispatching'] })).toEqual(['task'])
    expect(updateBusyReasons({ ...IDLE, taskStatuses: ['uncertain'] })).toEqual(['task'])
  })

  it('does not wait for paused, quota-paused, finished or cancelled tasks', () => {
    expect(updateBusyReasons({ ...IDLE, taskStatuses: ['paused', 'quota_paused', 'completed', 'cancelled'] })).toEqual(
      []
    )
  })

  it('reports a transcribing import as import', () => {
    expect(updateBusyReasons({ ...IDLE, importStates: ['done', 'transcribing'] })).toEqual(['import'])
    expect(updateBusyReasons({ ...IDLE, importStates: ['failed', 'policy-held', 'cancelled'] })).toEqual([])
  })

  it('lists several reasons in a stable order', () => {
    expect(
      updateBusyReasons({
        meetingReserved: true,
        captureActive: false,
        leasePurpose: 'dictation',
        taskStatuses: ['ready'],
        importStates: ['queued']
      })
    ).toEqual(['meeting', 'dictation', 'task', 'import'])
  })
})
