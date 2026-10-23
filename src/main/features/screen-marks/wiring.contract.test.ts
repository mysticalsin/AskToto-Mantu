import { describe, expect, it } from 'vitest'
import { SCREEN_MARKS_IPC } from '@shared/screen-marks'
import { QA_SCREEN_MARKS_IPC } from '@shared/screen-marks-qa'
import { readModuleSource } from '../../../test-helpers/module-source'

/** G43 wiring pins: the runtime is built and fed by the observation, channels match the preloads, QA IPC is flag-gated. */
const indexSrc = readModuleSource(__dirname, '../../index').text
const runtime = readModuleSource(__dirname, './runtime').text

describe('screen marks wiring (G43)', () => {
  it('index builds the runtime and hands its hooks to the screen observation', () => {
    expect(indexSrc).toMatch(/const screenMarks = createScreenMarksRuntime\(/)
    expect(indexSrc).toMatch(/createScreenObservation\(\{\s*\.\.\.screenMarks\.hooks,/)
  })

  it('destroys the windows on quit and defers screen events until the app is ready', () => {
    expect(runtime).toMatch(/app\.once\('will-quit', \(\) => core\.destroy\('quit'\)\)/)
    expect(runtime).toMatch(/app\.whenReady\(\)\.then\(/)
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) expect(runtime).toContain(event)
  })

  it('registers the QA placement IPC only under the compile-time QA identity', () => {
    expect(runtime).toMatch(/if \(\s*QA_IDENTITY_BUILD &&\s*qaScreenMarksEnabled\(/)
    expect(runtime).not.toContain('METIS_QA_SCREEN_MARKS')
    expect(runtime).not.toContain('screenMarks:qa')
  })

  it('the preload channel literals equal the shared channel tables', () => {
    const annotation = readModuleSource(__dirname, '../../../preload/annotation').text
    const qa = readModuleSource(__dirname, '../../../preload/screen-marks').text
    expect(annotation).toContain(`'${SCREEN_MARKS_IPC.marks}'`)
    expect(qa).toContain(`'${QA_SCREEN_MARKS_IPC.place}'`)
    expect(qa).toContain(`'${QA_SCREEN_MARKS_IPC.clear}'`)
  })

  it('the annotation window is created only by the runtime, with a fixed bundled page and its own preload', () => {
    expect(runtime).toContain("'../preload/annotation.js'")
    expect(runtime).toContain("'../renderer/annotation.html'")
  })
})
