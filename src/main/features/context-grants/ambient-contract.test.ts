import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'

const src = (spec: string): string => readModuleSource(__dirname, spec).text.replace(/\r\n/g, '\n')

/**
 * The snapshot store is filled only by an explicit owner gesture. These pins keep every ambient or background code
 * path from importing it, and keep the context runtime from reaching the capture seam.
 */
describe('snapshots are never filled by ambient code paths (contract)', () => {
  const importsContextGrants = /from\s+['"][^'"]*context-grants[^'"]*['"]/

  it.each([
    '../screen-observation/screen-observation',
    '../screen-observation/lifecycle',
    '../../screen-preprocess',
    '../../foreground-watcher',
    '../session-context/ask-context'
  ])('%s does not import the context-grants feature', (rel) => {
    expect(src(rel)).not.toMatch(importsContextGrants)
  })

  it('the runtime, store, grants and manifest never import a capture seam or the screen observation', () => {
    for (const file of ['runtime', 'snapshot-store', 'document-grants', 'manifest', 'ambient-screen']) {
      expect(src(`./${file}`), file).not.toMatch(
        /from\s+['"][^'"]*(screen-capture|screen-observation)|desktopCapturer|captureScreen|getScreenshot/
      )
    }
  })

  it('the store has exactly one write path and it names the gesture', () => {
    const text = src('./snapshot-store')
    expect(text.match(/io\.write\(/g)).toHaveLength(1)
    expect(text).toMatch(/SNAPSHOT_GESTURES/)
  })

  it('the only caller that builds an observation for the store is the explicit IPC request', () => {
    const text = src('../../ipc/context-grants-ipc')
    expect(text).toMatch(/CONTEXT_IPC\.snapshotRequest/)
    expect(text.match(/store\.request\(/g)).toHaveLength(1)
  })
})
