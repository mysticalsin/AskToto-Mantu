import { describe, expect, it } from 'vitest'
import {
  FIRST_INFERENCE_STATE,
  START_PATHS,
  contentFreeErrorMessage,
  launchEnv,
  preconditionReport,
  refusedStartPathEvidence,
  runPreconditionEvidence
} from './first-inference.mjs'

describe('first-inference census helper', () => {
  it('selects app-owned start paths in the same order as the positive control', () => {
    expect(START_PATHS.map((path) => path.name)).toEqual([
      'window.toto.localPrewarm',
      'window.toto.ask (suggest, local route)'
    ])
    expect(START_PATHS[0].evaluate()).toContain('window.toto.localPrewarm')
    expect(START_PATHS[1].evaluate()).toContain('window.toto.ask')
    expect(START_PATHS[1].evaluate()).toContain('"mode":"suggest"')
  })

  it('records the census precondition evidence without prompt or transcript content', () => {
    expect(
      runPreconditionEvidence({
        status: 'PASS',
        path: 'window.toto.localPrewarm',
        firstTokenSeen: true
      })
    ).toBe('start path: window.toto.localPrewarm; first token seen: yes')

    expect(() => runPreconditionEvidence({ status: 'PRECONDITION' })).toThrow(/completed local inference control/)
  })

  it('maps a refused model start to a NOT_MEASURED PRECONDITION artifact', () => {
    const report = preconditionReport({
      platform: 'darwin',
      productVersion: '1.9.7',
      seconds: 300,
      mainPid: 123,
      reason: 'no app start path completed local inference',
      refused: ['window.toto.localPrewarm', 'window.toto.ask (suggest, local route)']
    })

    expect(report).toMatchObject({
      ticket: 'M2-0562',
      evidenceLevel: 'PRECONDITION',
      productVersion: '1.9.7',
      platform: 'darwin',
      state: FIRST_INFERENCE_STATE,
      seconds: 300,
      mainPid: 123,
      status: 'NOT_MEASURED',
      statePrecondition: {
        required: true,
        status: 'PRECONDITION',
        reason: 'no app start path completed local inference',
        refusedStartPaths: ['window.toto.localPrewarm', 'window.toto.ask (suggest, local route)']
      },
      hostFloorOverride: true
    })
  })

  it('names the refusing gate without leaking prompt content or local paths', () => {
    const evidence = refusedStartPathEvidence(
      'window.toto.localPrewarm',
      new Error('local.prewarm.free-ram-floor refused /private/var/folders/profile resource census first-inference proof')
    )

    expect(evidence).toBe('window.toto.localPrewarm (local.prewarm.free-ram-floor refused [path] [redacted])')
    expect(evidence).toContain('local.prewarm.free-ram-floor refused')
    expect(evidence).not.toContain('/private/')
    expect(evidence).not.toContain('resource census first-inference proof')
    expect(contentFreeErrorMessage('')).toBe('start path refused')
  })

  it('keeps the output content-free and strips secrets while scoping the RAM-floor override to the launch env', () => {
    const reportText = JSON.stringify(
      preconditionReport({
        platform: 'win32',
        productVersion: '2.0.0',
        seconds: 300,
        mainPid: null,
        reason: 'renderer bridge unreachable',
        refused: []
      })
    )
    expect(reportText).not.toContain('synthetic local inference proof')
    expect(reportText).not.toContain('THEM:')
    expect(reportText).not.toContain('/Users/')

    const env = launchEnv(
      {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'redacted',
        METIS_QA_HOST_FLOOR_OVERRIDE: '0'
      },
      '/tmp/metis-profile'
    )
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      ASKTOTO_USERDATA: '/tmp/metis-profile',
      METIS_QA_HOST_FLOOR_OVERRIDE: '1'
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
  })
})
