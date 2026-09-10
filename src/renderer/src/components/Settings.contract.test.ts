/**
 * Settings.contract.test.ts — source-contract test for five renderer-only bugs fixed in Settings.tsx
 * (fix batch B_Settings). There is no component-render harness for Settings.tsx anywhere in this repo
 * (it's a large, deeply-nested Electron settings panel wired to window.toto IPC stubs), so — following
 * App.local-gates.test.ts / local-prewarm.test.ts's "structural proof" pattern (readFileSync + regex over
 * the real source) — this pins the shape of each fix so a future edit can't silently regress it.
 *
 * Anchors are function/branch names, never line numbers, so reordering unrelated code doesn't break this.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { pickReadyProvider, detectHint, SETTINGS_CONTENT_SCROLL_CLASS, settingsScrollClipsOverflowX } from './Settings'

// Normalize CRLF → LF: on a Windows checkout Settings.tsx has \r\n line endings, and a marker whose
// newline sits mid-string (e.g. finding 5's '))}\n          </div>') would never match '))}\r\n...'.
// Normalizing keeps every anchor line-ending-independent without weakening what each one pins.
const source = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8').replace(/\r\n/g, '\n')

// Returns the source slice from `startAnchor` up to (not including) the first `endMarker` found after it.
function blockAfter(startAnchor: string, endMarker: string): string {
  const start = source.indexOf(startAnchor)
  if (start === -1) throw new Error(`Settings.contract.test.ts anchor not found (source moved?): ${startAnchor}`)
  const end = source.indexOf(endMarker, start)
  if (end === -1) throw new Error(`Settings.contract.test.ts end marker not found after anchor: ${endMarker}`)
  return source.slice(start, end)
}

describe('Local AI tells the truth about a model that is downloaded, not bundled (MQA-187/188/191)', () => {
  const block = blockAfter('function LocalAiSection(', '\nfunction StepBadge(')
  // Copy assertions run over the code with `//` comments stripped. The comments explain WHY the old
  // wording was wrong and legitimately quote it; that text never reaches a user.
  const copy = block.replace(/^\s*\/\/.*$/gm, '')

  it('loads readiness metadata and exposes start/retry, not cancel/delete', () => {
    // The download state rides localModels:list. Retry re-arms ensureLocalModel without toggling Local AI.
    expect(block).toMatch(/window\.toto\.localModelsList\(\)/)
    expect(block).toMatch(/localModelsEnsure\(\)/)
    expect(block).not.toMatch(/localModelsDownload|localModelsCancel|localModelsDelete/)
  })

  it('MQA-188 — never claims the model ships in the installer', () => {
    // electron-builder.yml copies only the licence file; scripts/check-packaged-runtime.mjs fails the
    // build if a .gguf ever returns. "Included with Métis" was false on every install, ready ones too.
    expect(copy).not.toMatch(/Included with Métis/)
    expect(copy).not.toMatch(/no separate model download/i)
    expect(copy).not.toMatch(/bundled model/i)
    // Optional weights are fetched automatically only after opt-in, or by an explicit Retry.
    expect(copy).toMatch(/downloads automatically only after you enable Local AI/i)
    expect(copy).toMatch(/Retry to download without enabling/i)
    expect(copy).not.toMatch(/when the app opens|when Métis opens|once on first run|~730 MB/i)
  })

  it('MQA-191 — never tells the user to reinstall, which cannot restore weights no installer carries', () => {
    expect(copy).not.toMatch(/[Rr]einstall/)
  })

  it('MQA-187 — an in-flight download reads as a download, with its progress', () => {
    expect(block).toMatch(/unavailableReason === 'downloading'/)
    expect(block).toMatch(/downloadProgress/)
    expect(block).toMatch(/Downloading/)
  })

  it('MQA-187 — a failed download names what has to be reachable and when it retries', () => {
    expect(block).toMatch(/unavailableReason === 'download-failed'/)
    expect(block).toMatch(/huggingface\.co/)
    expect(block).toMatch(/next launch/i)
    expect(copy).toMatch(/next launch while Local AI is enabled/i)
  })

  it('MQA-187 — the card re-polls while a download is running or has not started', () => {
    expect(block).toMatch(/setTimeout/)
    expect(block).toMatch(/'downloading'/)
    expect(block).toMatch(/'not-downloaded'/)
  })

  it('still renders ready, unavailable and the RAM floor', () => {
    expect(block).toMatch(/model\.ready/)
    expect(block).toMatch(/model\.unavailableReason === 'insufficient-ram'/)
    expect(block).toMatch(/Ready/)
    expect(block).toMatch(/Unavailable/)
  })

  it('a disk or RAM skip is a named refusal with Retry, not a silent idle', () => {
    expect(block).toMatch(/unavailableReason === 'insufficient-disk'/)
    expect(block).toMatch(/not enough free disk space/)
    expect(block).toMatch(/insufficient-ram/)
    expect(block).toMatch(/canRetry/)
    expect(block).toMatch(/insufficient-disk/)
    expect(block).toMatch(/Retry/)
  })

  it('contains a Retry control for a failed or not-yet-started fetch, not delete/cancel', () => {
    expect(block).toMatch(/Retry/)
    expect(block).toMatch(/localModelsEnsure/)
    expect(block).not.toMatch(/>\s*Download\s*</)
    expect(block).not.toMatch(/>\s*Delete\s*</)
    expect(block).not.toMatch(/>\s*Cancel\s*</)
  })

  it('exposes an in-flight fetching state with progress', () => {
    expect(block).toMatch(/Downloading \$\{percent\}%/)
    expect(block).toMatch(/unavailableReason === 'downloading'/)
  })
})

describe("runtime status line reads the true tri-state, not a boolean (finding 2)", () => {
  const block = blockAfter('settings.localRuntimeState', '</div>')

  it('the not-running branch no longer promises an unconditional automatic restart', () => {
    // The old copy asserted "starts automatically" as fact with no hedge or recovery path — that stayed
    // reassuring even once local-runtime.ts's restart budget was exhausted for the rest of the session.
    expect(block).not.toMatch(/starts automatically on the first live suggestion/)
  })

  it("distinguishes the 'unavailable' lockout from a normal idle stop and names the app-restart recovery", () => {
    // The tri-state now has a dedicated 'unavailable' branch (restart-budget lockout, cleared only by
    // relaunch) that says so honestly, instead of the reassuring idle-stop copy.
    expect(block).toMatch(/localRuntimeState === 'unavailable'/)
    expect(block).toMatch(/Restart Métis/)
  })
})

describe('connectCli() branches on accessDenied instead of misdirecting into a generic "no session" message (finding 3)', () => {
  const block = blockAfter('const connectCli = async ()', '\n  // Save a Dust API key')

  it('checks r.accessDenied before falling through to the generic no-session message', () => {
    const deniedIdx = block.indexOf('r.accessDenied')
    const genericIdx = block.indexOf('No Dust CLI session found')
    expect(deniedIdx).toBeGreaterThan(-1)
    expect(genericIdx).toBeGreaterThan(-1)
    expect(deniedIdx).toBeLessThan(genericIdx)
  })

  it('the accessDenied branch returns before reaching the generic no-session message', () => {
    const deniedIdx = block.indexOf('if (r.accessDenied)')
    const nextReturn = block.indexOf('return', deniedIdx)
    const genericIdx = block.indexOf('No Dust CLI session found', deniedIdx)
    expect(nextReturn).toBeGreaterThan(-1)
    expect(nextReturn).toBeLessThan(genericIdx)
  })
})

describe('disconnectDust() clears dustTokenMintedAt (finding 4)', () => {
  const block = blockAfter('const disconnectDust = async ()', '\n  // Remove just the saved Dust API key')

  it('resets dustTokenMintedAt to 0 in the same patch as the rest of the disconnect reset', () => {
    expect(block).toMatch(/dustTokenMintedAt:\s*0/)
  })
})

describe('the Custom provider tile can actually be selected (finding 5)', () => {
  const block = blockAfter('{shown.map((id) => (', '))}\n          </div>')

  it("seeds a valid https:// customBaseUrl alongside provider:'custom' so SettingsSchema's refine " +
      '(provider !== \'custom\' || /^https:\\/\\//i.test(customBaseUrl)) does not revert the write', () => {
    expect(block).toMatch(/id === 'custom'/)
    expect(block).toMatch(/customBaseUrl:\s*'https:\/\//)
  })

  it('does not touch customBaseUrl when one is already a valid https:// URL (no clobbering a real endpoint)', () => {
    expect(block).toMatch(/!\/\^https:\\\/\\\/\/i\.test\(settings\.customBaseUrl\)/)
  })
})

describe('About footer version', () => {
  it('reads the release version from package.json instead of hard-coding a stale value', () => {
    expect(source).toContain("import appPackage from '../../../../package.json'")
    expect(source).toMatch(/Métis \{appPackage\.version\} · Mantu/)
    expect(source).not.toMatch(/Métis 1\.0\.0 · Mantu/)
  })
})

describe('About footer Support / Send feedback route to the maintained mailbox', () => {
  // Both the "Support" and "Send feedback" links must reach twalteur@amaris.com. The prior
  // support@mantu.com mailbox is not monitored for this app, so a bug report or feedback sent there
  // is silently lost — pin the live address so an edit can't quietly revert it.
  it('Support links to twalteur@amaris.com', () => {
    expect(source).toMatch(/href="mailto:twalteur@amaris\.com"[\s\S]{0,120}?>\s*Support/)
  })

  it('Send feedback links to twalteur@amaris.com (subject preserved)', () => {
    expect(source).toMatch(/href="mailto:twalteur@amaris\.com\?subject=[^"]*"[\s\S]{0,120}?>\s*Send feedback/)
  })

  it('the unmonitored support@mantu.com mailbox is gone from the footer', () => {
    expect(source).not.toMatch(/mailto:support@mantu\.com/)
  })
})

describe('MQA-060 — the Test button is not offered in the state where it can only fail', () => {
  const block = blockAfter('onClick={onTest}', '</button>')

  it('is disabled on an empty input, because the stored key is never sent back to the renderer', () => {
    // Without this the button is enabled whenever a key is SAVED (the field is always empty on open —
    // it is cleared on mount, on provider change and after every save), so the only thing it can
    // produce there is onTest's "Paste a key above to test it." error.
    expect(block).toMatch(/disabled=\{[^}]*!key\.trim\(\)/)
  })

  it('explains in the tooltip why a saved key cannot be re-tested', () => {
    expect(block).toMatch(/title=/)
    expect(block).toMatch(/saved key is never shown here/)
  })
})

describe('MQA-069 — the Advanced model fields commit on the debounce boundary, not per keystroke', () => {
  const advanced = blockAfter('Base model · fast, cheap', 'Creativity ·')

  it('both model inputs are LazyInput + onCommit (no per-keystroke settings write)', () => {
    // A plain controlled <input> here writes settings.json over IPC on every keystroke and the
    // re-render then resets the DOM to an already-resolved earlier patch — fast typing drops
    // characters and persists a garbled model id.
    expect(advanced).toMatch(/<LazyInput[\s\S]*id=\{modelInputId\}/)
    expect(advanced).toMatch(/<LazyInput[\s\S]*id=\{`think-\$\{provider\}`\}/)
    expect(advanced).toMatch(/providerModels:\s*\{\s*\.\.\.settings\.providerModels,\s*\[provider\]:\s*v\s*\}/)
    expect(advanced).toMatch(
      /providerModelsThinking:\s*\{\s*\.\.\.settings\.providerModelsThinking,\s*\[provider\]:\s*v\s*\}/
    )
    expect(advanced).not.toMatch(/onChange=/)
  })

  it('LazyInput forwards `list` so the model fields keep their datalist suggestions', () => {
    expect(blockAfter('function LazyInput(', '\ntype AsrCorrection')).toMatch(/list=\{list\}/)
  })
})

describe('MQA-091 — a CRM disconnect that left the key file on disk is reported, not swallowed', () => {
  const block = blockAfter('const disconnect = async ()', '\n  return (')

  it('checks r.ok and renders the handler’s error instead of closing the card silently', () => {
    expect(block).toMatch(/const r = await window\.toto\.mcpDisconnect\(\{ connectionId \}\)/)
    expect(block).toMatch(/if \(!r\.ok\)/)
    expect(block).toMatch(/phase: 'error', error: r\.error/)
  })

  it('keeps the panel open on failure so the existing error strip is on screen', () => {
    const failure = block.indexOf('if (!r.ok)')
    expect(failure).toBeGreaterThan(-1)
    expect(block.indexOf('setOpen(true)', failure)).toBeGreaterThan(failure)
  })
})

describe('MQA-095 — provider auto-selection respects the org allowlist', () => {
  const hasGrokKey = { grok: true }

  it('pickReadyProvider never lands on a ready-but-blocked provider', () => {
    // Without the allowlist argument this returns 'grok' — a provider with no tile in the grid, that
    // every ask then rejects with "not on your organization's approved provider list".
    expect(pickReadyProvider('anthropic', hasGrokKey, {}, '', {}, ['openai'])).toBe('openai')
  })

  it('falls back to an approved provider when nothing is ready and Anthropic is blocked', () => {
    expect(pickReadyProvider('grok', {}, {}, '', {}, ['openai'])).toBe('openai')
  })

  it('is unchanged with no allowlist: the first ready provider wins, else Anthropic', () => {
    expect(pickReadyProvider('anthropic', hasGrokKey, {}, '', {}, null)).toBe('grok')
    expect(pickReadyProvider('anthropic', {}, {}, '', {}, null)).toBe('anthropic')
  })

  it('detectHint stops promising an auto-switch to a blocked provider', () => {
    const blocked = detectHint('xai-abcdef', 'openai', ['openai'])
    expect(blocked?.kind).toBe('tip')
    expect(blocked?.text).toMatch(/restricted by your organization/)
    // Unrestricted orgs keep the original copy.
    expect(detectHint('xai-abcdef', 'openai', null)).toEqual({
      kind: 'ok',
      text: 'Detected Grok · xAI. Selected automatically.'
    })
  })

  it('onKeyChange gates the auto-switch on the allowlist', () => {
    const block = blockAfter('const onKeyChange = (value: string)', '\n  const onSave')
    expect(block).toMatch(/const allowed = settings\.allowedProviders/)
    expect(block).toMatch(/!allowed \|\| allowed\.includes\(id\)/)
  })
})

// MQA-062 — the CLI cards used to render straight off the persisted `cliConnected` flag with no live
// check, so a `claude logout` in a terminal left them reading Connected/Active indefinitely. Dust already
// states the rule for this credential class (lib/dust-live-check.ts: "Persisted state can lie … opening
// Settings must verify the real session instead of taking 'already connected' for granted") and
// implements it for itself; this is the same check for the two CLI providers.
describe('MQA-062 — CLI Integration verifies the real session when the panel opens', () => {
  const block = (): string => blockAfter('const sessionCheckedRef = useRef(false)', 'const [claudeState')

  it('probes through main, not by spawning a billed testCli from the renderer', () => {
    expect(block()).toMatch(/window\.toto\.cliVerifySessions\(\)/)
    expect(block()).not.toMatch(/cliTest/)
  })

  it('only fires when something claims to be connected', () => {
    expect(block()).toMatch(/if \(!cliConnected\['claude-cli'\] && !cliConnected\['codex-cli'\]\) return/)
  })

  it('runs once per mount — the ref is set before the await, not after', () => {
    const body = block()
    expect(body).toMatch(/if \(sessionCheckedRef\.current\) return/)
    expect(body.indexOf('sessionCheckedRef.current = true')).toBeLessThan(body.indexOf('window.toto.cliVerifySessions()'))
    expect(body).toMatch(/\}, \[\]\)/) // mount-only, like the Dust probe above it
  })
})

describe('CLI Connect treats a weekly cap as signed-in, not disconnected', () => {
  it('the Connect handler keeps weekly-limit on the done path', () => {
    const body = blockAfter("const connect = async (id: 'claude-cli' | 'codex-cli')", 'const cancel =')
    expect(body).toMatch(/r\.session === 'weekly-limit'/)
    expect(body).toMatch(/phase: 'done'/)
  })

  it('installs in-flow when the session probe says missing, then proves again', () => {
    const body = blockAfter("const connect = async (id: 'claude-cli' | 'codex-cli')", 'const cancel =')
    expect(body).toMatch(/r\.session === 'missing'/)
    expect(body).toMatch(/cliInstall/)
    expect(body).toMatch(/r\.session === 'signed-out'/)
    expect(body).toMatch(/cliLogin/)
  })
})

describe('CLI Integration copy — managed install, not npm i -g', () => {
  it('does not advertise npm i -g as the happy path', () => {
    const block = blockAfter('title="CLI Integration"', 'icon={Link2}')
    expect(block).not.toMatch(/npm i -g/)
    expect(block).toMatch(/managed copy/)
    expect(block).toMatch(/live session check/)
  })
})

describe('Set up automatically shows an honest status chip', () => {
  const cli = (): string => blockAfter('function CliIntegration(', '\nfunction McpConnectionCard(')
  const install = (): string =>
    blockAfter('const runInstall = async (id: \'claude-cli\' | \'codex-cli\')', 'const connect = async')

  it('keeps Set up automatically and walks install → login → Connected', () => {
    const body = cli()
    expect(body).toMatch(/Set up automatically/)
    expect(body).toMatch(/data-cli-setup-chip/)
    expect(body).toMatch(/Waiting for login/)
    expect(body).toMatch(/canShowConnected/)
    expect(body).toMatch(/nextCliSetupStep/)
    expect(install()).toMatch(/window\.toto\.cliInstall\(id/)
    expect(install()).toMatch(/window\.toto\.cliTest\(id\)/)
    expect(install()).toMatch(/window\.toto\.cliLogin\(id\)/)
    expect(body).toMatch(/lastClickedCli/)
    expect(body).toMatch(/CLI Integration/)
  })

  it('a click without a working binary cannot show Connected', () => {
    const body = install()
    expect(body).toMatch(/if \(!binaryPresent\)/)
    expect(body).toMatch(/canShowConnected\(\{ binaryPresent, testOk \}\)/)
    expect(body).not.toMatch(/phase: 'done'[\s\S]{0,80}binaryPresent: false/)
  })
})

// MQA-164 — the in-app download had no failure path: main logged the electron-updater 'error' and told
// nobody, so UpdatesSection stayed in phase 'downloading' — a progress bar that could never move again,
// with its own download-page fallback ("Always reachable so the user is never stranded") hidden, because
// that link renders only in phase 'blocked' or 'idle'.
describe('MQA-164 — a failed update download leaves the Settings row with a way out', () => {
  const block = (): string => blockAfter('function UpdatesSection(', '\nfunction ModePromptEditor')

  it('tells the user only a QA-approved Latest is offered', () => {
    expect(block()).toMatch(/QA-approved Latest from Metis-Releases/)
    expect(block()).toMatch(/Draft and prerelease builds are never offered/)
  })

  it('subscribes to the download-failure channel alongside progress and ready', () => {
    expect(block()).toMatch(/window\.toto\.onUpdateError\(/)
  })

  it('moves out of the fake progress bar into the state that renders the download-page link', () => {
    const body = block()
    const handler = body.slice(body.indexOf('window.toto.onUpdateError('))
    expect(handler).toMatch(/setPhase\('blocked'\)/)
    expect(handler).toMatch(/setDownloadError\(/)
  })

  // The renderer can only see the event if preload bridges it — the whole path is main → preload → row.
  it('is bridged by preload on the shared update:error channel', () => {
    const preload = readFileSync(join(__dirname, '../../../preload/index.ts'), 'utf8')
    expect(preload).toMatch(/onUpdateError: .*sub\(IPC\.updateError, cb\)/)
  })
})

describe('Set up Dust installs the managed CLI, then signs in', () => {
  it('startDustOAuth calls dustInstallCli before dustLoginBegin', () => {
    const body = blockAfter('const startDustOAuth = async', 'useEffect(() => {')
    expect(body).toMatch(/window\.toto\.dustInstallCli\(\)/)
    expect(body).toMatch(/window\.toto\.dustLoginBegin\(\)/)
    expect(body.indexOf('dustInstallCli()')).toBeLessThan(body.indexOf('dustLoginBegin()'))
    expect(body).toMatch(/Could not install the Dust CLI/)
  })

  it('the Set up Dust button copy is install, not reconnect / No CLI', () => {
    const block = blockAfter("title={active ? 'Dust CLI · Your agents (active)'", '\nfunction getAudioChoices(')
    const copy = block.replace(/^\s*\/\/.*$/gm, '')
    expect(copy).toMatch(/Installing Dust CLI/)
    expect(copy).toMatch(/Installs the Dust CLI, then opens your browser/)
    expect(copy).not.toMatch(/No CLI/)
    expect(copy.toLowerCase()).not.toMatch(/reconnect dust in settings/)
  })
})

describe('BRAIN-CONNECTORS — one-click ClickUp and Plane, Polo form stays', () => {
  const product = blockAfter('function ProductConnectCard(', '\nfunction ClickupCard(')
  const polo = blockAfter('function McpConnectionCard(', '\nconst primaryBtnStyle')
  const intelligence = blockAfter('function IntelligenceTab(', '\nfunction GraphSection(')
  const productCopy = product.replace(/^\s*\/\/.*$/gm, '')

  it('ClickUp and Plane default cards have no MCP URL field', () => {
    const clickup = blockAfter('function ClickupCard(', '\nfunction PlaneCard(')
    const plane = blockAfter('function PlaneCard(', '\nfunction AgentPicker(')
    expect(productCopy).not.toMatch(/MCP endpoint URL/)
    expect(clickup).toMatch(/<ClickUpMark/)
    expect(plane).toMatch(/<PlaneMark/)
    expect(intelligence).toMatch(/<ClickupCard /)
    expect(intelligence).toMatch(/<PlaneCard /)
  })

  it('ClickUp Connect is the default CTA — no endpoint or key input until Advanced opens', () => {
    expect(product).toMatch(/\{connecting \? waitingLabel : 'Connect'\}/)
    expect(product).toMatch(/advanced \? \(/)
    expect(product).toMatch(/API key/)
    const keyInput = product.indexOf('type="password"')
    const advancedGate = product.indexOf('{advanced ? (')
    expect(keyInput).toBeGreaterThan(advancedGate)
  })

  it('Polo Pre-Sales still has the existing URL + key + Test + Save form', () => {
    expect(polo).toMatch(/MCP endpoint URL/)
    expect(polo).toMatch(/API key/)
    expect(polo).toMatch(/Test connection/)
    expect(polo).toMatch(/Save/)
    expect(intelligence).toMatch(/kind="bidstack"/)
    expect(intelligence).toMatch(/defaultLabel="Polo Pre-Sales"/)
    expect(intelligence).not.toMatch(/kind="plane"/)
  })

  it('never auto-sends: product-connect cards have no useEffect that connects or pushes', () => {
    expect(product).not.toMatch(/useEffect/)
    expect(product).not.toMatch(/mcpPush/)
    expect(product).toMatch(/onClick=\{\(\) => void runConnect\(\)\}/)
  })

  it('ClickUp connected line names the destination list when known', () => {
    expect(product).toMatch(/Tasks go to \$\{conn\.clickupListName\}/)
    expect(product).toMatch(/clickupListName: r\.clickupListName/)
  })

  it('official marks are the vendored simple-icons paths, not Lucide stand-ins', () => {
    const clickup = readFileSync(join(__dirname, 'brand/ClickUpMark.tsx'), 'utf8')
    const plane = readFileSync(join(__dirname, 'brand/PlaneMark.tsx'), 'utf8')
    expect(clickup).toMatch(/#7B68EE/)
    expect(clickup).toMatch(/M2 18\.439l3\.69-2\.828/)
    expect(plane).toMatch(/currentColor/)
    expect(plane).toMatch(/M0 5\.358a\.854/)
  })
})

// Instant validate: Dust connect must live-ping and fail loud. No green Connected from a saved key
// alone, and never an auto-sent chat as the "proof".
describe('Dust instant validate proves a live connection', () => {
  const setup = (): string => blockAfter('function DustSetup(', '\nfunction getAudioChoices(')
  const copy = (): string => setup().replace(/^\s*\/\/.*$/gm, '')

  it('CLI import does not paint ok:true / Loading agents before the live prove', () => {
    const connect = blockAfter('const connectCli = async ()', '\n  const oauthIdle')
    expect(connect).not.toMatch(/ok:\s*true[\s\S]{0,80}Loading agents/)
    expect(connect).toMatch(/proveAfterConnect/)
    expect(connect).toMatch(/Checking Dust connection/)
  })

  it('OAuth workspace pick awaits the live prove and fails the oauth phase on error', () => {
    const pick = blockAfter('const pickDustWorkspace = async', '\n  // Save a Dust API key')
    expect(pick).toMatch(/proveAfterConnect/)
    expect(pick).toMatch(/if \(!verdict\.ok\)/)
    expect(pick).toMatch(/phase: 'error'/)
  })

  it('Save API key tests the pasted key before persisting and does not fire-and-forget loadAgents', () => {
    const save = blockAfter('const saveDustKey = async', '\n  const recoverProfileAndRetryDustKey')
    expect(save).toMatch(/window\.toto\.testApiKey\('dust', k\)/)
    expect(save.indexOf("testApiKey('dust', k)")).toBeLessThan(save.indexOf("saveKey('dust', k)"))
    expect(save).toMatch(/decideDustInstantValidate/)
    expect(save).not.toMatch(/void loadAgents\(\)/)
    expect(save).toMatch(/DUST_WORKSPACE_MISSING_SETUP_ERROR/)
  })

  it('loadAgents treats an empty list as a failure, not a loaded picker', () => {
    const load = blockAfter('const loadAgents = async', '\n  // When Dust was already connected')
    expect(load).toMatch(/r\.agents\.length > 0/)
    expect(load).toMatch(/DUST_EMPTY_AGENTS_ERROR/)
  })

  it('green Connected requires a proved agent list and shows the count, not a static "Dust is connected."', () => {
    const body = copy()
    expect(body).not.toMatch(/Dust is connected\./)
    expect(body).not.toMatch(/Connected\. Loading agents/)
    expect(body).toMatch(/formatDustConnectedMessage/)
    expect(body).toMatch(/listProved/)
    expect(setup()).toMatch(/Checking Dust connection/)
  })

  it('Reconnect installs the CLI first and surfaces a human install error, not Connected', () => {
    const start = blockAfter('const startDustOAuth = async', '\n  // Poll at the server-given cadence')
    expect(start).toMatch(/dustInstallCli/)
    expect(start.indexOf('dustInstallCli')).toBeLessThan(start.indexOf('dustLoginBegin'))
    expect(start).toMatch(/if \(!installed\.ok\)/)
    expect(start).toMatch(/phase: 'error'/)
    expect(start).not.toMatch(/Connected/)
  })

  it('never auto-sends a chat as the connection test', () => {
    const body = setup()
    expect(body).not.toMatch(/createConversation|postUserMessage|streamAgent/)
    expect(body).toMatch(/Never auto-sends a chat/)
  })
})

describe('Settings Bar rest orb picker', () => {
  it('wires OverlayOrbPicker next to Overlay chrome only when Bar is selected', () => {
    expect(source).toMatch(/overlayShowsBarRestPicker/)
    expect(source).toMatch(/overlayShowsBarRestPicker\(settings\.overlayLayout\)/)
    expect(source).toMatch(/OverlayOrbPicker/)
    expect(source).toMatch(/overlayOrbStyle: id/)
    expect(source).toMatch(/Applies when Overlay chrome is Bar/)
    const appearance = source.slice(source.indexOf('title="Appearance"'), source.indexOf('title="Language"'))
    expect(appearance).toMatch(/overlayShowsBarRestPicker\(settings\.overlayLayout\)/)
    const gated = appearance.slice(
      appearance.indexOf('overlayShowsBarRestPicker(settings.overlayLayout)'),
      appearance.indexOf(') : null}')
    )
    expect(gated).toMatch(/<OverlayOrbPicker/)
    expect(gated).toMatch(/Bar rest/)
    const orbBlock = source.slice(source.indexOf('<OverlayOrbPicker'), source.indexOf('<OverlayOrbPicker') + 400)
    expect(orbBlock).not.toMatch(/\u2014/)
  })
})

describe('Settings from M scrolls the full surface', () => {
  it('fills the 880×800 window and scrolls cl-content end to end', () => {
    expect(source).toMatch(/cl-root flex h-full min-h-0/)
    expect(source).toMatch(/className=\{SETTINGS_CONTENT_SCROLL_CLASS\}/)
    expect(source).toMatch(/cl-content scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden/)
    expect(source).not.toMatch(/max-h-\[480px\]/)
    expect(source).not.toMatch(/panel-enter/)
    expect(source).toMatch(/Custom instructions/)
  })
})

describe('Settings scroll root clips sideways overflow (Win Audio / AI)', () => {
  it('the scroll-class helper rejects overflow-x auto/scroll/visible and requires hidden/clip', () => {
    expect(settingsScrollClipsOverflowX(SETTINGS_CONTENT_SCROLL_CLASS)).toBe(true)
    expect(settingsScrollClipsOverflowX('cl-content scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden')).toBe(true)
    expect(settingsScrollClipsOverflowX('cl-content scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-clip')).toBe(true)
    // The pre-fix class: overflow-y-auto alone computes overflow-x: auto (CSS pairing).
    expect(settingsScrollClipsOverflowX('cl-content scroll-thin min-h-0 flex-1 overflow-y-auto')).toBe(false)
    expect(settingsScrollClipsOverflowX('cl-content overflow-y-auto overflow-x-auto')).toBe(false)
    expect(settingsScrollClipsOverflowX('cl-content overflow-y-auto overflow-x-scroll')).toBe(false)
    expect(settingsScrollClipsOverflowX('cl-content overflow-y-auto overflow-x-visible')).toBe(false)
    expect(settingsScrollClipsOverflowX('overflow-x-hidden')).toBe(false)
  })

  it('the live Settings tabpanel uses the clipping scroll class', () => {
    expect(source).toMatch(/className=\{SETTINGS_CONTENT_SCROLL_CLASS\}/)
    expect(SETTINGS_CONTENT_SCROLL_CLASS).toMatch(/\boverflow-y-auto\b/)
    expect(SETTINGS_CONTENT_SCROLL_CLASS).toMatch(/\boverflow-x-hidden\b/)
    expect(SETTINGS_CONTENT_SCROLL_CLASS).not.toMatch(/\boverflow-x-(?:auto|scroll|visible)\b/)
  })
})

describe('Operator control plane lives on Cloudflare, not in Settings', () => {
  it('exposes Operator URL, ingest secret, metadata-only privacy copy, and Open Operator', () => {
    expect(source).toMatch(/Operator URL/)
    expect(source).toMatch(/Ingest secret/)
    expect(source).not.toMatch(/Send Ask text for skill improvement/)
    expect(source).not.toMatch(/settings\.sendAskText/)
    expect(source).not.toMatch(/Only operational metadata leaves this device/)
    expect(source).toMatch(/Operator telemetry sends only operational metadata/)
    expect(source).toMatch(/Content is not included in telemetry/)
    expect(source).toMatch(/Provider inference and\s+user-approved\s+destination writes are separate/)
    expect(source).toMatch(/Open Operator/)
    expect(source).toMatch(/operatorOpen/)
    expect(source).toMatch(/DEFAULT_OPERATOR_URL/)
    expect(source).toMatch(/operatorUrlConfigured/)
    expect(source).toMatch(/operatorUrlConfigured\(settings\) && <OperatorLicenseCard/)
    expect(source).toMatch(/Empty uses the shipped Operator URL at runtime/)
    expect(source).not.toMatch(/Empty means no fleet heartbeat/)
    expect(source).not.toMatch(/metis-operator\.example\.workers\.dev/)
  })

  it('does not keep a local-only Operator tools dashboard or fake fleet numbers', () => {
    expect(source).not.toMatch(/operatorTools/)
    expect(source).not.toMatch(/Operator tools/)
    expect(source).not.toMatch(/local analytics page that pretends/)
    expect(source).not.toMatch(/DAU/)
    expect(source).not.toMatch(/cache hit rate/)
    const operator = blockAfter('title="Operator"', '\n            {tab === \'meetings\'')
    expect(operator).not.toMatch(/—/)
    expect(operator).not.toMatch(/I am an AI|as an AI|AI assistant/i)
  })
})

describe('locked mode skills — Settings has no editor for shipped skill files', () => {
  const personalize = blockAfter('function ModePromptEditor(', '\nconst TEXT_FILE_RE')

  it('shows a read-only locked line and never edits skill files', () => {
    expect(personalize).toMatch(/Operator skill v/)
    expect(personalize).toMatch(/cannot be\s+edited, deleted, or overridden here/)
    expect(personalize).toMatch(/modeSkillLock\(\)/)
    expect(personalize).not.toMatch(/writeFileSync/)
    expect(personalize).not.toMatch(/skills\/modes/)
    expect(personalize).not.toMatch(/SKILL\.md/)
    expect(personalize).not.toMatch(/onCommit=\{\(v\) => patch\(\{[^}]*skill/)
  })

  it('the prompt textarea still edits modePrompts only', () => {
    expect(personalize).toMatch(/patch\(\{ modePrompts:/)
    expect(source).not.toMatch(/modeSkills/)
    expect(source).not.toMatch(/skillsRoot/)

  })
})

describe('Cloudflare tile opens Operator OAuth, not a key-paste card', () => {
  it('calls cloudflareConnect and does not bind a Worker URL paste field', () => {
    expect(source).toMatch(/window\.toto\.cloudflareConnect/)
    expect(source).toMatch(/data-cf-aig-connect/)
    expect(source).not.toMatch(/value=\{settings\.cloudflareBaseUrl\}/)
    expect(source).not.toMatch(/Paste the Worker/)
    const preload = readFileSync(join(__dirname, '../../../preload/index.ts'), 'utf8')
    expect(preload).toMatch(/cloudflareConnect:/)
  })
})
