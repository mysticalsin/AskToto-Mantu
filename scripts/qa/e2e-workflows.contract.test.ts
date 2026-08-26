import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SUITE = readFileSync(join(__dirname, 'e2e-workflows.mjs'), 'utf8')

/**
 * MQA-255 — the physical QA suite has to measure the APP, not the machine it ran on.
 *
 * It reported 10 failures against a healthy build. Every one traced to something other than the product:
 *
 *   5  the on-device weights were still downloading on a fresh profile, so every "answers on-device"
 *      check fell through to a cloud provider — the app behaving exactly as designed;
 *   1  the operator launched with ASKTOTO_DISABLE_CP=1, which turns content protection off, and the
 *      suite duly reported that Private View did not block capture;
 *   3  leftover state from the suite's OWN previous run: groups restore what they mutate on the happy
 *      path, but a group that FAILS never reaches its restore, so run two inherited run one's residue;
 *   3  provider keys exported in the shell environment. store.ts's getApiKey reads
 *      process.env[ENV_VAR[provider]] BEFORE the profile store, so "zero API keys configured" cannot be
 *      arranged on such a machine at all — no isolated profile can remove them.
 *
 * A red line that is not a defect is worse than no line: it is what teaches people that red lines do not
 * mean anything. So the suite now separates "the app is broken" from "this environment cannot test that",
 * and says which blocker applies. These are pinned because both halves rot silently — a restore that
 * stops running, or a genuine failure quietly downgraded to a note.
 */
describe('MQA-255 — the QA suite reports the build, not the environment', () => {
  it('snapshots the settings it mutates and restores them afterwards', () => {
    // Without this, running the suite twice against one profile produces different answers — which means
    // at least one of those answers is wrong about the app.
    expect(SUITE).toMatch(/const SETTINGS_SNAPSHOT = await/)
    expect(SUITE).toMatch(/async function restoreSettingsSnapshot\(\)/)
    expect(SUITE).toMatch(/await restoreSettingsSnapshot\(\)/)
    // Restore must run after the groups and before the summary is computed, so a failing group cannot
    // skip it the way per-group restores were skipped.
    const restoreAt = SUITE.indexOf('await restoreSettingsSnapshot()')
    const summaryAt = SUITE.indexOf("const passed = results.filter((r) => r.status === 'pass').length")
    expect(restoreAt).toBeGreaterThan(-1)
    expect(summaryAt).toBeGreaterThan(restoreAt)
  })

  it('lets a check downgrade ITSELF to "not exercised" rather than failing', () => {
    expect(SUITE).toMatch(/typeof detail\.__info === 'string'/)
    expect(SUITE).toMatch(/record\(group, name, 'info', detail\.__info\)/)
  })

  it('never folds a not-exercised check into the passed count', () => {
    // The whole point of the third state: a check that did not run must not read as one that succeeded.
    expect(SUITE).toMatch(/const skipped = results\.filter\(\(r\) => r\.status === 'info'\)\.length/)
    expect(SUITE).toMatch(/const passed = results\.filter\(\(r\) => r\.status === 'pass'\)\.length/)
  })

  it('names the specific blocker, never a bare "skipped"', () => {
    // "not exercised" with no reason is just a failure nobody will investigate.
    for (const blocker of [
      /weights are still arriving/,
      // The env-key blocker is now phrased from the APP's answer rather than the shell's — see MQA-256's
      // sibling fix. It must still say WHICH providers are stuck and why no profile can clear them.
      /they come from its ENVIRONMENT/,
      /working \$\{r\.providers\.at\(-1\)\} key/
    ]) {
      expect(SUITE).toMatch(blocker)
    }
  })

  it('still FAILS hard when the model is present, not downloading, and not ready', () => {
    // The line between environment and defect. Weights on disk that will not load is a real bug — a bad
    // RAM floor, a damaged file — and must not be absorbed by the same excuse as a cold profile.
    expect(SUITE).toMatch(/no ready model and none downloading/)
  })
})

/**
 * MQA-256 — the on-device guard was ordered AFTER the assert it was supposed to pre-empt.
 *
 * MQA-255 added `if (!localModelReady) return { __info }` to the checks that depend on the on-device
 * floor, but placed it below `assert(!r.error, ...)`. On a warm profile that is invisible. On a genuine
 * first run it is not: the weights are still downloading, and the profile has no cloud key beyond the
 * embedded one the test itself clears, so the ask legitimately errors — and the assert fires first,
 * turning "this environment cannot test that yet" back into red lines about the app.
 *
 * Observed on 2026-08-25 against the packaged 1.6.2 build on a genuinely fresh profile: six failures,
 * every one of them the guard arriving too late. The fix is ordering, so ordering is what is pinned.
 */
describe('MQA-256 — the on-device guard must run before the assert it exists to pre-empt', () => {
  it('places a localModelReady guard ahead of every error assert', () => {
    const lines = SUITE.split(/\r?\n/)
    const asserts: number[] = []
    lines.forEach((l, i) => {
      if (/^\s*assert\(!r\.error,/.test(l)) asserts.push(i)
    })
    expect(asserts.length).toBeGreaterThan(0)
    for (const a of asserts) {
      const above = lines.slice(Math.max(0, a - 6), a).join(' ')
      expect(
        /if \(!localModelReady\) return \{ __info/.test(above),
        `the error assert on line ${a + 1} has no on-device guard above it — a first-run profile reports it as an app failure`
      ).toBe(true)
    }
  })
})

/**
 * MQA-257 — a check whose NAME asserted the opposite of the shipped design.
 *
 * "everything needed to run is bundled — no post-install download required" ran on every pass. The
 * product deliberately does the opposite: electron-builder.yml excludes the ~728 MB Qwen weights,
 * because a universal build carrying them would exceed GitHub's 2 GB per-asset limit, and
 * local-model-download.ts fetches them once on first run from a pinned immutable revision.
 *
 * So the check could only ever pass on a warm profile, and on a real first install it was guaranteed
 * red — which is how a name that lies about the design survives: nobody runs the fresh-profile case.
 */
describe('MQA-257 — the bundling check must describe what the product actually ships', () => {
  it('no longer claims the on-device weights are bundled', () => {
    // The phrase still appears in the comment that explains why it was retired — that is the record of
    // the decision and must survive. What must NOT survive is a CHECK asserting it.
    expect(SUITE).not.toMatch(/check\([a-z]+, 'everything needed to run is bundled/)
  })

  it('checks the promise that IS made: ASR ships, and the LLM is ready or visibly arriving', () => {
    expect(SUITE).toMatch(/ASR ships bundled, and the on-device LLM is either ready or visibly arriving/)
    // "neither ready nor downloading" stays a hard failure — that one is a real defect.
    expect(SUITE).toMatch(/neither ready nor downloading/)
  })
})

/**
 * MQA-258 — Mantu Intelligence, extraction accuracy, and latency had no end-to-end coverage at all.
 *
 * The dashboard ships nine views in their own window behind their own preload. The suite's only touch
 * was `graphify status answers`, which proves an IPC handler replies and nothing about whether a single
 * view renders. Separately, 58 checks asked "did it answer?" and none asked "was the answer right", and
 * nothing anywhere was timed — so a change that tripled time-to-answer, or one that made extraction
 * silently return an empty graph, shipped green.
 */
describe('MQA-258 — the dashboard, accuracy, and latency are exercised, not assumed', () => {
  it('registers the three groups', () => {
    for (const g of ['intelligence: groupIntelligence', 'accuracy: groupAccuracy', 'latency: groupLatency']) {
      expect(SUITE).toContain(g)
    }
  })

  it('drives every route a user can click, not just the window opening', () => {
    const routes = [
      "'/coaching', 'Coaching'",
      "'/deals', 'Deals'",
      "'/accounts', 'Accounts'",
      "'/people', 'People'",
      "'/stats', 'Stats'",
      "'/graph', 'Relationships'",
      "'/meetings', 'Meetings'"
    ]
    for (const route of routes) expect(SUITE).toContain(route)
    expect(SUITE).toMatch(/renders without hitting the error boundary/)
  })

  it('holds the dashboard preload to read-only', () => {
    // The dashboard window is a READER; a privileged write reaching it is a security regression.
    expect(SUITE).toMatch(/the dashboard preload stays read-only/)
    expect(SUITE).toMatch(/that is the privileged main-window API/)
  })

  it('compares the graph tile against the DISPLAY graph, derived with the adapter own predicate', () => {
    // getData() returns the BRAIN shape; account_graph only exists after brainToDashboard runs in the
    // renderer. Asserting on a field that is absent by construction fails for the wrong reason.
    expect(SUITE).toMatch(/the graph tile counts the DISPLAY graph, not the raw brain graph/)
    expect(SUITE).toMatch(/that is the RAW brain count, the regression is back/)
  })

  it('tests accuracy in BOTH directions, not just recall', () => {
    // A hallucinated commitment is worse than a missed one: it puts words in the user's mouth.
    expect(SUITE).toMatch(/PRECISION: the hypothetical aside was NOT recorded as a commitment/)
    expect(SUITE).toMatch(/RECALL: the commitment made in the transcript survives to the graph/)
  })

  it('waits for ITS OWN transcript before judging extraction', () => {
    // Keying on "any file ingested" let an earlier group's fixture satisfy the wait, so this group read
    // the graph before its own file existed and reported recall failures against an empty result.
    expect(SUITE).toMatch(/Wait for THIS transcript, not for any transcript/)
  })

  it('sends the schema field the app actually reads', () => {
    // AskStartBaseSchema calls it `prompt`. `text` is not in the schema, so it silently defaults to ''
    // and the app correctly answers "I don't have any input yet" — a green-looking test of nothing.
    expect(SUITE).not.toMatch(/ask\(\{[^}]*\btext:/)
  })

  it('reports latency numbers even when they pass, so a trend is visible', () => {
    expect(SUITE).toMatch(/settings round-trip is instant/)
    expect(SUITE).toMatch(/an on-device ask answers within the on-device budget/)
  })
})

/**
 * MQA-261 — the physical suite must exercise the way back, not just the removal.
 *
 * The defect was silent: clearing the shipped key left the app answering, on the on-device model, an order
 * of magnitude slower. A suite that only checks "a key can be cleared" would have stayed green through it.
 */
describe('MQA-261 — removing the shipped key is not a one-way door', () => {
  it('drives remove -> restore against the real app', () => {
    expect(SUITE).toMatch(/the shipped Cloudflare key survives being removed/)
    expect(SUITE).toMatch(/window\.toto\.restoreEmbeddedCloudflareKey\(\)/)
  })

  it('fails if the build stops offering a restore the moment the key is gone', () => {
    // That is the exact state the user lands in, so it is the one that must be asserted.
    expect(SUITE).toMatch(/the user has no way back/)
  })

  it('always leaves the key restored, even when its own assertions fail', () => {
    // A QA run must not be the thing that strands a profile on the slow path.
    expect(SUITE).toMatch(/Never leave the profile without the key it shipped with/)
  })
})

/**
 * MQA-264 — the blocker message named an action that cannot succeed.
 *
 * "start scripts/qa/mock-llm-server.mjs" was the entire instruction. Started that way the mock listens on
 * plain HTTP, while this group probes HTTPS (the app's customBaseUrl refine rejects anything else), so the
 * operator follows the instruction, sees the same "not exercised" line, and has no idea why. The whole
 * Cloudflare failure-matrix group had never run in any recorded session as a result.
 */
describe('MQA-264 — a not-exercised message must name the whole requirement', () => {
  it('names the TLS env vars, not just the script', () => {
    // Asserted individually: the message is a concatenation, so the two names are not adjacent in source.
    expect(SUITE).toContain('MOCK_TLS_CERT')
    expect(SUITE).toContain('MOCK_TLS_KEY')
    expect(SUITE).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0')
  })

  it('says outright that starting the mock alone is insufficient', () => {
    // Without this the reader assumes they did it right and stops investigating.
    expect(SUITE).toMatch(/Starting the mock alone is not enough/)
  })
})

/**
 * MQA-265 — the accuracy group could never settle on Windows, and could hang the whole suite.
 *
 * Two defects in one loop, both found by running the packaged 1.6.3 end to end:
 *
 * 1. The basename was computed with `file.split(/[\/]/)` — a character class holding a single escaped
 *    FORWARD slash. Every fixture path on Windows is backslash-separated, so split() returned the whole
 *    path, pop() returned the whole path, and `basename.includes(wholePath)` was false on every
 *    iteration. `mine` could never become true. The group burned its entire budget and reported "not
 *    exercised" on every run, while extraction had in fact been working the whole time.
 *
 * 2. The per-iteration probe was unbounded. The deadline is only consulted BETWEEN iterations, so a
 *    single CDP call that never settles blocks the loop and therefore the entire suite. Observed on
 *    2026-08-25: this group sat for roughly 50 minutes against a 12-minute budget while the app itself
 *    stayed responsive to other clients.
 */
describe('MQA-265 — the settle loop must be able to succeed, and must not be able to hang', () => {
  it('splits the fixture path on BOTH separators', () => {
    // Asserted via the surrounding code rather than by escaping a regex that matches a regex — that
    // escaping is precisely what produced the bug being pinned here.
    const idx = SUITE.indexOf('const base = file ?')
    expect(idx, 'the basename is no longer hoisted out of the loop').toBeGreaterThan(-1)
    const decl = SUITE.slice(idx, idx + 120)
    // A backslash must appear inside the split character class; the forward-slash-only form has none.
    const charClass = decl.slice(decl.indexOf('split('), decl.indexOf('.pop()'))
    expect(charClass.includes(String.fromCharCode(92)), `split class lacks a backslash: ${charClass}`).toBe(true)
  })

  it('bounds every probe, not just the total wait', () => {
    expect(SUITE).toMatch(/Promise\.race\(\[/)
    expect(SUITE).toMatch(/setTimeout\(\(\) => r\(null\), 20000\)/)
    // A probe failure must read as "not settled yet", never abort the group.
    expect(SUITE).toMatch(/window\.toto\.brainStatus\(\)\)\.catch\(\(\) => null\)/)
  })

  it('states the budget it actually enforces', () => {
    // The accuracy message said 6 min after its budget was raised to 12 — a stale instruction sends the
    // reader looking for a timeout that is not the one that fired. Scoped to the accuracy group on
    // purpose: the brain group genuinely uses 6 min and correctly says so, and forbidding the string
    // repo-wide would fail on a message that is telling the truth.
    expect(SUITE).toMatch(/did not settle within 12 min[^']*--only=accuracy/)
  })

  it('bounds the brain group probe as well, not only accuracy', () => {
    // Same hang, second site: whichever group hangs takes every group after it with it.
    const brainAt = SUITE.indexOf('while (Date.now() < settleDeadline)')
    expect(brainAt).toBeGreaterThan(-1)
    expect(SUITE.slice(brainAt, brainAt + 700)).toMatch(/Promise\.race\(\[/)
  })
})
