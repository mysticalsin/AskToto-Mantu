/**
 * Tonight gate: every Métis ask must sit on KineticGrid release/1.8.3 → 1.8.7.
 * Pre-Kinetic tips (615e5fa / 13092a3 without 92e9d0d) fail this file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
  scripts: Record<string, string>
}
const experience = readFileSync(join(root, 'src/renderer/src/components/OnboardingExperience.tsx'), 'utf8')
const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const settings = readFileSync(join(root, 'src/renderer/src/components/Settings.tsx'), 'utf8')
const intel = readFileSync(join(root, 'src/main/intelligence.ts'), 'utf8')
const intelButton = readFileSync(join(root, 'intelligence/src/components/IntelligenceUpdateButton.tsx'), 'utf8')
const orb = readFileSync(join(root, 'src/shared/overlay-orb.ts'), 'utf8')
const chrome = readFileSync(join(root, 'src/shared/overlay-chrome.ts'), 'utf8')
const geometry = readFileSync(join(root, 'src/main/island/geometry.ts'), 'utf8')
const jarvis = readFileSync(join(root, 'src/renderer/src/lib/jarvis-orb.ts'), 'utf8')
const flow = readFileSync(join(root, 'src/renderer/src/lib/onboarding-flow.ts'), 'utf8')
const kinetic = readFileSync(join(root, 'src/renderer/src/lib/onboarding-kinetic-grid.ts'), 'utf8')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

describe('1.8.7 KineticGrid tip checklist', () => {
  it('1 KineticGrid after lady, no Skip, Ready-only done, no rotating stripe wash', () => {
    expect(existsSync(join(root, 'src/renderer/src/components/onboarding/KineticGrid.tsx'))).toBe(true)
    expect(kinetic).toMatch(/shouldMountKineticGrid/)
    expect(kinetic).toMatch(/'problem'/)
    expect(experience).toMatch(/shouldMountKineticGrid\(scene\) && <KineticGrid/)
    expect(experience).toMatch(/scene === 'hero' && <OnboardingHeroVideo/)
    expect(experience).not.toMatch(/Skip the tour/)
    expect(flow).toMatch(/input\.scene === 'ready' && input\.asrReady && input\.consent/)
    expect(app).not.toMatch(/onboard-stripes/)
    expect(css).not.toMatch(/onboard-stripes/)
    expect(css).not.toMatch(/onboard-stripe-spin/)
    expect(geometry).toMatch(/isForbiddenHideParkHairline/)
    expect(index).toMatch(/hideParkWindowOpacity/)
    expect(index).toMatch(/app\.setName\('Métis'\)/)
    expect(index).not.toMatch(/Metis Tip|Métis Tip/)
    expect(geometry).toMatch(/EXCLUSIVE_ONBOARDING_BACKGROUND = '#05010A'/)
    expect(geometry).not.toMatch(/EXCLUSIVE_ONBOARDING_BACKGROUND = '#3A0B6B'/)
    expect(experience).toMatch(/lockOnboardingAudio\(\)/)
    expect(experience).toMatch(/setupAsrBlocksContinue\(rows, asrStatus\)/)
    expect(experience).toMatch(/summarizeSetupRows\(rows\)\.allReady/)
    expect(app).toMatch(/if \(settings\?\.onboardingDone\) lockOnboardingAudio\(\)/)
  })

  it('2 exclusive onboarding cannot be dragged off-screen', () => {
    const gate = app.slice(
      app.indexOf("settings && !settings.onboardingDone && DEMO == null"),
      app.indexOf('const panelOpen')
    )
    expect(gate).toMatch(/onboard-stage onboard-exclusive-lock/)
    expect(gate).not.toMatch(/windowDrag/)
    expect(index).toMatch(/movable: !onboardingLive/)
    expect(index).toMatch(/function moveBy[\s\S]{0,200}if \(onboardingExclusiveLive\(\)\) return/)
  })

  it('3 Hide top-edge Ask 880×120, leave parks 8×2, re-hover keeps Ask', () => {
    expect(chrome).toMatch(/ASK_REVEAL_MIN_HEIGHT_PX = 120/)
    expect(geometry).toMatch(/OVERLAY_HIDE_PARK = \{ width: 8, height: 2 \}/)
    expect(app).toMatch(/reveal-now/)
    expect(app).toMatch(/parkAfterHide/)
    const parkFx = app.slice(app.indexOf('shouldForceParkOnBecameIdle'), app.indexOf('const revealOverlay'))
    expect(parkFx).toMatch(/parkAfterHide/)
    expect(parkFx).not.toMatch(/ask\.clear/)
  })

  it('4 Settings closed does not keep a gray slab under Bar/Circle', () => {
    expect(chrome).toMatch(/export function overlayShowsSettingsSheet/)
    expect(chrome).toMatch(/return view === 'settings' && !minimized/)
    expect(index).toMatch(/function healHideGhostSlab/)
    expect(app).toMatch(/overlayShowsSettingsSheet\(view, minimized\)/)
  })

  it('5 Circle is Jakub default; Jarvis is option 2 with intense 800 pill cloud', () => {
    expect(orb).toMatch(/DEFAULT_OVERLAY_ORB_STYLE: OverlayOrbStyle = 'jakub'/)
    expect(orb).toMatch(/title: 'Circle'/)
    expect(orb).toMatch(/title: 'Jarvis'/)
    expect(jarvis).toMatch(/JARVIS_PILL_PARTICLE_COUNT = 800/)
    expect(jarvis).toMatch(/createJarvisPointSprite/)
    expect(jarvis).not.toMatch(/JARVIS_PILL_PARTICLE_COUNT = 2000/)
  })

  it('6 package.json is 1.8.7', () => {
    expect(pkg.version).toBe('1.8.7')
  })

  it('7 Intelligence bundle is ensured; UI says Mantu Intelligence', () => {
    expect(pkg.scripts.prebuild).toMatch(/ensure-intelligence-bundle/)
    expect(pkg.scripts.dev).toMatch(/ensure-intelligence-bundle/)
    expect(intel).toMatch(/Intelligence dashboard bundle not found/)
    expect(intelButton).toMatch(/ReactElement/)
    expect(intelButton).not.toMatch(/JSX\.Element/)
    expect(settings).toMatch(/title="Mantu Intelligence"/)
  })

  it('8 Métis is on the 1.8.7 line; Cloudflare tile opens Operator OAuth', () => {
    expect(pkg.version).toBe('1.8.7')
    expect(settings).toMatch(/connectCloudflare/)
    expect(settings).toMatch(/window\.toto\.cloudflareConnect/)
    expect(settings).toMatch(/data-cf-aig-connect/)
    expect(settings).toMatch(/Log in to Cloudflare/)
    expect(settings).toMatch(/Paste is not the happy path/)
    expect(settings).not.toMatch(/value=\{settings\.cloudflareBaseUrl\}/)
    expect(settings).not.toMatch(/Paste the Worker/)
    expect(settings).not.toMatch(/Connect with browser/)
    expect(settings).not.toMatch(/Sign in with Cloudflare/)
    expect(settings).not.toMatch(/cloudflareOAuth/)
  })

  it('9 PR148 Security is on this tip, not parked on a side branch', () => {
    expect(existsSync(join(root, 'docs/NETWORK-EGRESS.md'))).toBe(true)
    expect(existsSync(join(root, 'src/main/net/egress-policy.ts'))).toBe(true)
    expect(existsSync(join(root, 'src/main/net/egress-guard.ts'))).toBe(true)
    expect(existsSync(join(root, 'src/shared/question-type.ts'))).toBe(true)
    expect(index).toMatch(/installEgressGuard\(getEgressAllowlist\(\)\)/)
    expect(index).toMatch(/ProviderIdSchema\.safeParse/)
    expect(index).toMatch(/classifyQuestionType/)
    expect(index).toMatch(/new BoundedSet/)
    expect(settings).toMatch(/canShowConnected\(\{ binaryPresent, testOk \}\)/)
    expect(settings).toMatch(/listProved = !!agents && agents\.length > 0 && !err/)
  })
})
