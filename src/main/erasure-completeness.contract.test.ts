import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Erasure completeness — "Delete all Metis data" is a GDPR right-to-erasure promise ("This permanently
 * removes every saved transcript, note, and the knowledge graph from this device"), so every DERIVED
 * plaintext copy of a meeting has to go with the transcripts: the `.brain/` store, the published
 * `wiki/` mirror (written with `encrypt: false` by design), and the userData/graph artifacts.
 *
 * src/main/index.ts boots Electron at import time and each of these seams is a closure inside an
 * ipcMain handler, so there is no index.test.ts anywhere in this repo — this pins the wiring against the
 * actual source, exactly as index-audit-fixes.contract.test.ts / settings-write-boundary.contract.test.ts
 * do. The behavior of the pieces the handler calls is tested for real next to each of them: removeWiki in
 * brain/publish.test.ts, purgeGraphArtifacts in graphify.test.ts, purgeBrain in brain/brain.test.ts.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test so
 *  one drifted marker reports as its own failure instead of aborting collection for the whole file. */
function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

describe('MQA-149 — a full erasure takes the published wiki mirror with it', () => {
  const deleteAll = (): string => sliceBetween('ipcMain.handle(IPC.recallDeleteAll', '// --- Parakeet ASR engine ---')

  it('deletes the cleartext wiki/ mirror alongside the transcripts, the brain and the graph', () => {
    // A plain statement, never guarded: a mirror outlives publishBrainPages being turned off whenever
    // that removal failed, so gating this on the current setting would leave exactly the copy erasure is
    // asked to remove.
    expect(deleteAll()).toMatch(/^ +const wiki = removeWiki\(getSettings\(\)\)$/m)
  })

  it('reports a mirror it could not remove instead of returning a silent success', () => {
    const body = deleteAll()
    expect(body).toMatch(/wikiRemoved: wiki\.ok/)
    expect(body).toMatch(/if \(!wiki\.ok\)/)
    expect(body).toMatch(/\.\.\.result,[\s\S]*?ok: false,[\s\S]*?error:/)
  })

  it('still purges the derived artifacts when the meetings were already deleted one-by-one', () => {
    // The old `if (meetings.length === 0) return { ok: true, deleted: 0 }` returned BEFORE purgeBrain,
    // purgeGraphArtifacts and the wiki removal — an empty meetings folder is not an empty profile.
    expect(deleteAll()).not.toMatch(/meetings\.length === 0\) return/)
  })

  it('removes the deleted meeting note card on the single-delete path', () => {
    // recallDelete only requested a source refresh, and maybeStartSourceRefresh bails on a busy queue /
    // pending replay / no usable provider — so the orphan card could outlive the transcript forever.
    expect(sliceBetween('ipcMain.handle(IPC.recallDelete,', '// Recall rename:')).toMatch(
      /publishMeetingCard\(getSettings\(\), safeName\)/
    )
  })
})

describe('MQA-170 — the graph purge covers the runner directory and only audits a purge that happened', () => {
  it('gates the graph.purged audit line on the purge actually removing something', () => {
    // purgeGraphIfEncryptedAndStale runs on EVERY settingsGet poll and at boot: auditing unconditionally
    // once the predicate widens past graph.html would write a graph.purged record forever.
    const fn = sliceBetween('function purgeGraphIfEncryptedAndStale', 'let lastAppliedManagedSnapshot')
    expect(fn).toMatch(/if \(getSettings\(\)\.encryptTranscripts && purgeGraphArtifacts\(\)\) auditLog\('graph\.purged'/)
    expect(fn).not.toMatch(/graphHtml\(\)/)
  })

  it('gates the settingsSet-time audit line the same way', () => {
    const edge = sliceBetween('// At-rest encryption just turned on', '// publishBrainPages turned off')
    expect(edge).toMatch(/if \(!wasEncrypted && next\.encryptTranscripts && purgeGraphArtifacts\(\)\)/)
  })
})
