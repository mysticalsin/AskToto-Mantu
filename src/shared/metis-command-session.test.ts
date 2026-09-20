import { describe, expect, it } from 'vitest'
import {
  idleMetisCommandSession,
  reduceMetisCommandSession
} from './metis-command-session'
import { METIS_PILL_HI, METIS_PILL_LISTENING } from './metis-wake'

describe('Cap2 command session', () => {
  it('meeting audio without wake never executes', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, {
      type: 'transcript',
      text: 'open notes create a note titled hello',
      channel: 'meeting'
    })
    expect(s.active).toBe(false)
    expect(s.pending).toHaveLength(0)
    expect(s.pillVisible).toBe(false)
  })

  it('meeting audio cannot activate or execute even when it contains the wake word', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, {
      type: 'transcript',
      text: 'Métis open notes',
      channel: 'meeting'
    })
    expect(s).toEqual(idleMetisCommandSession())
  })

  it('meeting audio cannot add an action to an already trusted command session', () => {
    let s = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript',
      text: 'Métis',
      channel: 'command'
    })
    s = reduceMetisCommandSession(s, {
      type: 'transcript',
      text: 'Métis open notes',
      channel: 'meeting'
    })
    expect(s.pending).toEqual([])
    expect(s.liveTranscript).toBe('Métis')
  })

  it('wake word starts session with single chime + Hi Métis', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, {
      type: 'transcript',
      text: 'Hey Métis',
      channel: 'command'
    })
    expect(s.active).toBe(true)
    expect(s.pillVisible).toBe(true)
    expect(s.pillCopy).toBe(METIS_PILL_HI)
    expect(s.chime).toBe('single')
  })

  it('tick advances pill copy to listening', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, { type: 'transcript', text: 'Métis', channel: 'command' })
    s = reduceMetisCommandSession(s, { type: 'tick_listening_copy' })
    expect(s.pillCopy).toBe(METIS_PILL_LISTENING)
  })

  it('mid-sentence pending actions while active', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, { type: 'transcript', text: 'Métis', channel: 'command' })
    s = reduceMetisCommandSession(s, {
      type: 'transcript',
      text: 'Métis open notes',
      channel: 'command'
    })
    expect(s.pending.map((p) => p.id)).toEqual(['desktop.open_notes'])
    expect(s.phase).toBe('executing')
  })

  it('thank you double-chimes and dismisses pill', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, { type: 'transcript', text: 'Métis', channel: 'command' })
    s = reduceMetisCommandSession(s, {
      type: 'transcript',
      text: 'Thank you',
      channel: 'command'
    })
    expect(s.chime).toBe('double')
    expect(s.pillVisible).toBe(false)
    expect(s.active).toBe(false)
    expect(s.phase).toBe('deactivating')
  })

  it('Stop/Escape is local immediate deactivate', () => {
    let s = idleMetisCommandSession()
    s = reduceMetisCommandSession(s, { type: 'transcript', text: 'Métis', channel: 'command' })
    s = reduceMetisCommandSession(s, { type: 'stop' })
    expect(s.chime).toBe('double')
    expect(s.reason).toBe('local_stop')
    expect(s.active).toBe(false)
  })
})
