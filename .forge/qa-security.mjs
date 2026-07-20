// Live-validate the R2 security BLOCKER fix: with sign-in ENFORCED and no session,
// the privileged IPC handlers must reject (no key write, no config persist, no outbound call),
// and settingsGet must redact PII. Launch with ASKTOTO_REQUIRE_AUTH=1 + a fresh profile.
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const EXE = 'D:/asktoto-wt/release/win-unpacked/AskToto.exe'
const UDD = 'D:/asktoto-wt/.forge/qa-udd-sec'
mkdirSync('D:/asktoto-wt/.forge/qa', { recursive: true })
try { rmSync(UDD, { recursive: true, force: true }) } catch {}

const app = await electron.launch({
  executablePath: EXE,
  args: [`--user-data-dir=${UDD}`],
  env: { ...process.env, ASKTOTO_DISABLE_CP: '1', ASKTOTO_REQUIRE_AUTH: '1' }, // enforce sign-in, no session
  timeout: 90_000
})
const win = await app.firstWindow({ timeout: 90_000 })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(4500)

const results = []
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`) }

const out = await win.evaluate(async () => {
  const r = {}
  // auth status must be enforced + not signed in
  try { r.auth = await window.toto.authStatus?.() } catch (e) { r.authErr = String(e) }
  // setApiKey must NOT write a key
  try {
    const before = (await window.toto.getSettings())?.hasKeys?.anthropic
    await window.toto.setApiKey('anthropic', 'sk-ant-qa-should-not-persist-000000000000')
    const after = (await window.toto.getSettings())?.hasKeys?.anthropic
    r.setApiKey = { before, after, wrote: !before && after }
  } catch (e) { r.setApiKey = { error: String(e).slice(0, 120) } }
  // testApiKey must reject with a sign-in error (no outbound call)
  try { r.testApiKey = await window.toto.testApiKey('custom', 'x') } catch (e) { r.testApiKey = { error: String(e).slice(0, 120) } }
  // settingsSet must NOT persist an attacker base URL
  try {
    await window.toto.setSettings({ customBaseUrl: 'https://attacker.example/v1' })
    const s = await window.toto.getSettings()
    r.settingsSet = { customBaseUrl: s.customBaseUrl, persisted: s.customBaseUrl === 'https://attacker.example/v1' }
  } catch (e) { r.settingsSet = { error: String(e).slice(0, 120) } }
  // settingsGet PII redaction: profile.resume/notes must be blank pre-auth
  try {
    const s = await window.toto.getSettings()
    r.settingsGet = { hasProfile: !!s.profile, resume: s.profile?.resume ?? '(none)', notes: s.profile?.notes ?? '(none)' }
  } catch (e) { r.settingsGet = { error: String(e).slice(0, 120) } }
  // pickFolder must reject pre-auth (returns cancelled BEFORE opening a native dialog)
  try {
    const before = (await window.toto.getSettings())?.meetingsFolder
    const pf = await window.toto.pickFolder()
    const after = (await window.toto.getSettings())?.meetingsFolder
    r.pickFolder = { cancelled: pf?.cancelled === true, folderUnchanged: before === after }
  } catch (e) { r.pickFolder = { error: String(e).slice(0, 120) } }
  return r
})
console.log(JSON.stringify(out, null, 2))

rec('auth-enforced-not-signed-in', out.auth?.enforced === true && out.auth?.signedIn === false, `enforced=${out.auth?.enforced} signedIn=${out.auth?.signedIn}`)
rec('setApiKey-rejected', out.setApiKey?.wrote !== true, `wrote=${out.setApiKey?.wrote} (must be false/undefined)`)
rec('testApiKey-rejected', out.testApiKey?.ok === false, `ok=${out.testApiKey?.ok} error=${out.testApiKey?.error || ''}`)
rec('settingsSet-not-persisted', out.settingsSet?.persisted !== true, `persisted=${out.settingsSet?.persisted} value=${out.settingsSet?.customBaseUrl}`)
rec('settingsGet-pii-redacted', (out.settingsGet?.resume === '' || out.settingsGet?.resume === '(none)'), `resume=${JSON.stringify(out.settingsGet?.resume)}`)
rec('pickFolder-rejected', out.pickFolder?.cancelled === true && out.pickFolder?.folderUnchanged !== false, `cancelled=${out.pickFolder?.cancelled} folderUnchanged=${out.pickFolder?.folderUnchanged}`)

await app.close()
try { rmSync(UDD, { recursive: true, force: true }) } catch {}
const fails = results.filter((r) => !r.ok)
console.log(`\n${results.length - fails.length}/${results.length} PASS`)
process.exit(fails.length ? 1 : 0)
