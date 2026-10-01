import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

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

const MAIN_INDEX = ['src/main', 'index' + '.ts'].join('/')
const LLM_ENTRYPOINT = ['src/main', 'llm' + '.ts'].join('/')

const WIRED_CALL_SITES = [
  MAIN_INDEX,
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
    const text = src(MAIN_INDEX)
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
    const text = src(MAIN_INDEX)
    expect(text).toMatch(/enforceSttPolicy\(\s*getActiveModelPolicy\(settings\),\s*effectiveCloudSttProvider\(/)
  })

  it('the on-device readiness gate is installed from the localModel policy entry', () => {
    expect(src(MAIN_INDEX)).toContain('setLocalModelGate((modelId) => localModelAllowedByPolicy(getActiveModelPolicy(getSettings()), modelId))')
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

interface EnclosingFunction {
  name: string
  body: string
  node: ts.FunctionLikeDeclaration
  ancestors: EnclosingFunction[]
}

interface CreateStreamSite {
  file: string
  text: string
  call: ts.CallExpression
  fn: EnclosingFunction
}

function sourceFileFor(text: string): ts.SourceFile {
  return ts.createSourceFile('source', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function propertyNameText(name: ts.PropertyName | undefined, sf: ts.SourceFile): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return name.getText(sf)
}

function describeCallbackParent(node: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string | null {
  const parent = node.parent
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(sf)
    const firstArg = parent.arguments[0]?.getText(sf).replace(/\s+/g, ' ')
    return firstArg ? `${callee}(${firstArg})` : callee
  }
  if (ts.isNewExpression(parent)) return `new ${parent.expression.getText(sf)}`
  return null
}

function functionName(node: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string {
  const named = 'name' in node ? propertyNameText(node.name, sf) : null
  if (named) return named
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name, sf) ?? '<property>'
  if (ts.isMethodDeclaration(node)) return propertyNameText(node.name, sf) ?? '<method>'
  return describeCallbackParent(node, sf) ?? '<anonymous>'
}

function functionBody(node: ts.FunctionLikeDeclaration, text: string): string {
  return node.body ? text.slice(node.body.getFullStart(), node.body.getEnd()) : text.slice(node.getFullStart(), node.getEnd())
}

function enclosingFunctionChain(text: string, index: number): EnclosingFunction[] {
  const sf = sourceFileFor(text)
  const chain: EnclosingFunction[] = []
  const visit = (node: ts.Node, ancestors: EnclosingFunction[]): void => {
    if (index < node.getFullStart() || index > node.getEnd()) return
    const next =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
        ? [
            {
              name: functionName(node, sf),
              body: functionBody(node, text),
              node,
              ancestors
            }
          ]
        : []
    const active = next.length ? next : ancestors
    ts.forEachChild(node, (child) => visit(child, active))
    if (next.length) chain.push(next[0])
  }
  visit(sf, [])
  return chain.map((fn, i) => ({ ...fn, ancestors: chain.slice(i + 1) }))
}

/** Innermost function-like source that contains `index`, plus its best stable name. */
function enclosingFunction(text: string, index: number): EnclosingFunction {
  const chain = enclosingFunctionChain(text, index)
  return chain[0] ?? { name: '<module>', body: text, node: sourceFileFor(text) as unknown as ts.FunctionLikeDeclaration, ancestors: [] }
}

function namedFunction(text: string, name: string): string {
  const match = enclosingFunctionChain(text, text.indexOf(name)).find((fn) => fn.name === name)
  if (match) return match.body
  const sf = sourceFileFor(text)
  let body: string | null = null
  const visit = (node: ts.Node): void => {
    if (body) return
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) &&
      functionName(node, sf) === name
    ) {
      body = functionBody(node, text)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!body) throw new Error(`function ${name} not found`)
  return body
}

const resolvesThroughPolicy = (body: string): boolean =>
  /\b(?:narrowAllowedForCapability|resolveManagedModel|localModelAllowedByPolicy)\(/.test(body)

function isCreateStreamCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const expr = node.expression
  if (ts.isIdentifier(expr)) return expr.text === 'createStream'
  return ts.isPropertyAccessExpression(expr) && expr.name.text === 'createStream'
}

function createStreamSites(file: string): CreateStreamSite[] {
  const text = src(file)
  const createStreamMarkers = [...text.matchAll(/(?<!function )\bcreateStream\(/g)]
  if (createStreamMarkers.length === 0) return []
  const sf = sourceFileFor(text)
  const sites: CreateStreamSite[] = []
  const visit = (node: ts.Node): void => {
    if (isCreateStreamCall(node)) {
      sites.push({ file, text, call: node, fn: enclosingFunction(text, node.getStart(sf)) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

function modelArgumentText(site: CreateStreamSite): string {
  const [arg] = site.call.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg)) return ''
  const sf = sourceFileFor(site.text)
  const model = arg.properties.find(
    (prop): prop is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      ((ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'model')
  )
  if (!model) return ''
  return ts.isShorthandPropertyAssignment(model) ? model.name.text : model.initializer.getText(sf)
}

function policyBodyFor(site: CreateStreamSite): string {
  if (resolvesThroughPolicy(site.fn.body)) return site.fn.body
  const modelArg = modelArgumentText(site)
  if (!modelArg || /^[`'"]/.test(modelArg)) return site.fn.body
  const visibleBodies = [site.fn.body, ...site.fn.ancestors.map((fn) => fn.body)]
  const declaration = visibleBodies.find((body) =>
    new RegExp(`\\b(?:const|let|var)\\s+${modelArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s\\S]*?\\b(?:narrowAllowedForCapability|resolveManagedModel|localModelAllowedByPolicy)\\(`).test(body)
  )
  if (declaration) return declaration
  const ancestor = site.fn.ancestors.find((fn) => resolvesThroughPolicy(fn.body))
  return ancestor?.body ?? site.fn.body
}

// A call site that only streams a candidate handed to it names the function that built the candidate;
// that function must itself resolve through the policy.
const CANDIDATE_BUILDERS: Record<string, string> = {
  'src/main/brain/ingest.ts#runCompletionOnce': 'pickProviderCandidates',
  'src/main/brain/ingest.ts#new Promise': 'pickProviderCandidates'
}

function actualIndexFunction(name: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const sf = sourceFileFor(src(MAIN_INDEX))
  const declaration = sf.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  expect(declaration, `Actual source function ${name} was not found`).toBeDefined()
  if (!declaration) return () => undefined
  const compiled = ts.transpileModule(`${declaration.getText(sf)}\nglobalThis.result = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext(globals)
  vm.runInContext(compiled, context, { timeout: 1_000 })
  return (context as { result: (...args: any[]) => any }).result
}

describe('M2-0412 — every createStream( call site in src/main resolves through the fleet policy', () => {
  const sites = mainSources()
    .filter((f) => f !== LLM_ENTRYPOINT && !SPEECH_ENGINE_FILES.includes(f))
    .flatMap(createStreamSites)

  it('finds the known call sites (a scan that finds nothing must not pass vacuously)', () => {
    const found = new Set(sites.flatMap((s) => [s.fn, ...s.fn.ancestors].map((fn) => `${s.file}#${fn.name}`)))
    for (const expected of [
      `${MAIN_INDEX}#runImportPolish`,
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
    const body = builder ? namedFunction(site.text, builder) : policyBodyFor(site)
    expect(resolvesThroughPolicy(body), key).toBe(true)
  })

  it('sees nested arrow call sites as their innermost owner, so an outer gate cannot hide an ungated stream', () => {
    const fixture = `
      function registerIpc() {
        narrowAllowedForCapability(settings, allowed, 'askChat')
        ipcMain.handle('ask', () => {
          createStream({ model: 'raw-model' })
        })
      }
    `
    const call = fixture.indexOf('createStream')
    const fn = enclosingFunction(fixture, call)
    expect(fn.name).toBe("ipcMain.handle('ask')")
    expect(resolvesThroughPolicy(fn.body)).toBe(false)
  })

  it('gates the Settings local screen-check branch on the localModel policy before creating a stream', () => {
    const ask = namedFunction(src(MAIN_INDEX), 'askVisionForScreenCheck')
    const localBranch = ask.slice(ask.indexOf("if (backend === 'local')"), ask.indexOf('const provider = s.provider'))
    expect(localBranch).toContain('localModelAllowedByPolicy(getActiveModelPolicy(s), s.localLlm.modelId)')
    expect(localBranch.indexOf('localModelAllowedByPolicy')).toBeLessThan(localBranch.indexOf('createStream('))
    expect(localBranch.indexOf('Promise.reject')).toBeLessThan(localBranch.indexOf('createStream('))
    expect(localBranch).toContain('The selected provider is not allowed by the fleet model policy.')
  })

  it('rejects the Settings local screen-check branch with the policy error before any stream starts', async () => {
    const policy = { version: 1 }
    const createStream = vi.fn()
    const localModelAllowedByPolicy = vi.fn(() => false)
    const askVisionForScreenCheck = actualIndexFunction('askVisionForScreenCheck', {
      VISION_CHECK_PROMPT: 'Describe the screen.',
      VISION_CHECK_SYSTEM: 'Answer briefly.',
      getSettings: () => ({ localLlm: { modelId: 'blocked-local-model' } }),
      getActiveModelPolicy: () => policy,
      localModelAllowedByPolicy,
      collectVisionStream: vi.fn(),
      createStream,
      PROVIDERS: { local: { label: 'Metis Local' } }
    })

    await expect(askVisionForScreenCheck('local', 'base64-image')).rejects.toMatchObject({
      name: 'Error',
      message: 'The selected provider is not allowed by the fleet model policy.'
    })
    expect(localModelAllowedByPolicy).toHaveBeenCalledWith(policy, 'blocked-local-model')
    expect(createStream).not.toHaveBeenCalled()
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
