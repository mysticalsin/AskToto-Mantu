import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural proof (same "readFileSync + regex over the real source" pattern as
 * Settings.contract.test.ts — there is no integration harness that actually drives an ask/recap end
 * to end against a live Operator) that every REAL model call site in src/main resolves its
 * provider/model through the fleet model policy module (M2-0412) rather than only through
 * settings/allowedProviders. Pure resolver behaviour (precedence, narrowing, pinning) is covered by
 * src/shared/model-policy.test.ts and src/main/model-policy-client.test.ts; this test only pins that
 * each call site actually calls in.
 *
 * "Every call site" means every place that currently picks a cloud provider + model at all (see
 * AGENTS.md scope / M2-0412 ticket notes). Three capabilities in the policy schema — `commandAgent`,
 * `tts` and `embeddings` — have NO model-routed call site anywhere in this app (command parsing is
 * rule-based; there is no text-to-speech path; no embedding model is called), so there is nothing to
 * wire; the negative assertions below pin that absence rather than silently ignoring it. `stt` is
 * enforced where a cloud speech session starts and `localModel` in local-routing's readiness gate.
 */

const root = join(__dirname, '..', '..')

function src(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const WIRED_CALL_SITES = [
  'src/main/index.ts',
  'src/main/import-recap.ts',
  'src/main/brain/ingest.ts',
  'src/main/brain/intelligence-pass-route.ts'
]

describe('M2-0412 — every real model call site resolves through the fleet policy module', () => {
  it.each(WIRED_CALL_SITES)('%s imports from model-policy-client', (path) => {
    const text = src(path)
    expect(text).toMatch(/from ['"][./]+model-policy-client['"]/)
  })

  it('the interactive ask path (index.ts) narrows providers AND pins the model for the askChat capability', () => {
    const text = src('src/main/index.ts')
    expect(text).toContain("narrowAllowedForCapability(s, getAllowedProviders(), 'askChat'")
    expect(text).toContain("resolveManagedModel(s, 'askChat', provider, model)")
  })

  it('import-recap.ts, brain/ingest.ts and intelligence-pass-route.ts all resolve the recap capability', () => {
    for (const path of ['src/main/import-recap.ts', 'src/main/brain/ingest.ts', 'src/main/brain/intelligence-pass-route.ts']) {
      const text = src(path)
      expect(text, path).toContain("'recap'")
      expect(text, path).toMatch(/narrowAllowedForCapability|resolveManagedModel/)
    }
  })

  it('the cloud STT session start narrows the provider through the stt policy entry', () => {
    const text = src('src/main/index.ts')
    expect(text).toMatch(/enforceSttPolicy\(\s*getActiveModelPolicy\(settings\),\s*effectiveCloudSttProvider\(/)
  })

  it('the on-device readiness gate is installed from the localModel policy entry', () => {
    expect(src('src/main/index.ts')).toContain('setLocalModelGate((modelId) => localModelAllowedByPolicy(getActiveModelPolicy(getSettings()), modelId))')
    const routing = src('src/main/llm/local-routing.ts')
    expect(routing).toContain('if (!localModelGate(s.localLlm.modelId)) return false')
  })

  it('CLI providers and local are never narrowed by the fleet policy at any wired call site (own toggles govern them)', () => {
    for (const path of WIRED_CALL_SITES) {
      const text = src(path)
      if (!text.includes('narrowAllowedForCapability')) continue
      expect(text, path).toMatch(/\[\s*\.\.\.CLI_PROVIDER_IDS\s*,\s*'local'\s*\]/)
    }
  })
})

/** Every non-test source file under src/main (repo-relative, forward slashes). */
function mainSources(): string[] {
  return readdirSync(join(root, 'src/main'), { recursive: true, encoding: 'utf8' })
    .map((f) => join('src/main', f).replace(/\\/g, '/'))
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
}

// Speech-engine `createStream()` calls (sherpa recognizer / extractor streams) are audio decoders, not model calls.
const SPEECH_ENGINE_FILES = ['src/main/parakeet-asr-host.ts', 'src/main/speaker-embedding-host.ts']

const DECLARATION = /^(?:export )?(?:async )?function (\w+)/gm

/** Source of the column-0 function that contains `index`, plus its name. */
function enclosingFunction(text: string, index: number): { name: string; body: string } {
  const decls = [...text.matchAll(DECLARATION)]
  const start = [...decls].reverse().find((d) => (d.index ?? 0) <= index)
  if (!start) return { name: '<module>', body: text }
  const next = decls.find((d) => (d.index ?? 0) > (start.index ?? 0))
  return { name: start[1], body: text.slice(start.index, next?.index ?? text.length) }
}

function namedFunction(text: string, name: string): string {
  const decl = [...text.matchAll(DECLARATION)].find((d) => d[1] === name)
  if (!decl) throw new Error(`function ${name} not found`)
  return enclosingFunction(text, decl.index ?? 0).body
}

const resolvesThroughPolicy = (body: string): boolean => /\b(?:narrowAllowedForCapability|resolveManagedModel)\(/.test(body)

// A call site that only streams a candidate handed to it names the function that built the candidate;
// that function must itself resolve through the policy.
const CANDIDATE_BUILDERS: Record<string, string> = {
  'src/main/brain/ingest.ts#runCompletionOnce': 'pickProviderCandidates'
}

describe('M2-0412 — every createStream( call site in src/main resolves through the fleet policy', () => {
  const sites = mainSources()
    .filter((f) => f !== 'src/main/llm.ts' && !SPEECH_ENGINE_FILES.includes(f))
    .flatMap((file) => {
      const text = src(file)
      return [...text.matchAll(/(?<!function )\bcreateStream\(/g)].map((m) => ({ file, text, fn: enclosingFunction(text, m.index ?? 0) }))
    })

  it('finds the known call sites (a scan that finds nothing must not pass vacuously)', () => {
    const found = new Set(sites.map((s) => `${s.file}#${s.fn.name}`))
    for (const expected of [
      'src/main/index.ts#runImportPolish',
      'src/main/index.ts#askVisionForScreenCheck',
      'src/main/index.ts#registerIpc',
      'src/main/import-recap.ts#runImportedRecap',
      'src/main/brain/ingest.ts#runCompletionOnce'
    ]) {
      expect(found.has(expected), expected).toBe(true)
    }
  })

  it.each(sites.map((s) => [`${s.file}#${s.fn.name}`, s] as const))('%s resolves through the policy', (key, site) => {
    const builder = CANDIDATE_BUILDERS[key]
    const body = builder ? namedFunction(site.text, builder) : site.fn.body
    expect(resolvesThroughPolicy(body), key).toBe(true)
  })
})

describe('M2-0412 — capabilities with no model-routed call site are a documented absence, not a silent gap', () => {
  it('there is no text-to-speech call site anywhere in src/main (tts has nothing to enforce)', () => {
    const grep = (pattern: RegExp): boolean => {
      // Every non-test source file under src/main, so a synthesis call site cannot hide anywhere.
      const files = readdirSync(join(root, 'src/main'), { recursive: true, encoding: 'utf8' }).filter(
        (f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f)
      )
      return files.some((f) => pattern.test(src(join('src/main', f))))
    }
    expect(grep(/text-to-speech|synthesizeSpeech|ttsStream/i)).toBe(false)
  })

  it('command-agent parsing is rule-based, not model-routed (metis-command-parse.ts has no provider/model resolution)', () => {
    const text = src('src/shared/metis-command-parse.ts')
    expect(text).not.toMatch(/resolveModelTier|PROVIDERS\[/)
  })
})
