import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  isOnboardingBoot,
  exclusiveOnboardingFlag,
  provisionalOnboardingSettings,
  ONBOARDING_BOOT_POSTER_HREF
} from './onboarding-boot'

describe('isOnboardingBoot', () => {
  it('treats missing settings as onboarding (exclusive fail-closed, matches main)', () => {
    expect(isOnboardingBoot(null)).toBe(true)
    expect(isOnboardingBoot(undefined)).toBe(true)
  })

  it('treats onboardingDone false as onboarding', () => {
    const s = provisionalOnboardingSettings()
    expect(s.onboardingDone).toBe(false)
    expect(isOnboardingBoot(s)).toBe(true)
  })

  it('releases once onboardingDone is true', () => {
    const s = { ...provisionalOnboardingSettings(), onboardingDone: true }
    expect(isOnboardingBoot(s)).toBe(false)
  })
})

describe('provisionalOnboardingSettings', () => {
  it('parses as PublicSettings with onboardingDone false', () => {
    const s = provisionalOnboardingSettings()
    expect(s.onboardingDone).toBe(false)
    expect(s.provider).toBe('cloudflare')
    expect(s.hasApiKey).toBe(false)
  })
})

describe('FITO-185-I App boot gate (source contract)', () => {
  const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8')

  it('sync-imports OnboardingV2 so exclusive Act 1 does not wait on a lazy chunk', () => {
    expect(app).toMatch(/import\s*\{\s*OnboardingV2\s*\}\s*from\s*'\.\/components\/OnboardingExperience'/)
    expect(app).not.toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/components\/OnboardingExperience'/)
  })

  it('bypasses the settings/auth loading strip while isOnboardingBoot', () => {
    expect(app).toMatch(/isOnboardingBoot\(/)
    expect(app).toMatch(/provisionalOnboardingSettings\(/)
    expect(app).toMatch(/Onboarding gate FIRST/)
    expect(app).toMatch(/!isOnboardingBoot\(settings\)/)
    // Loading strip must not be the first exclusive paint (onboarding gate comes first).
    const onboardIdx = app.indexOf('Onboarding gate FIRST')
    const stripIdx = app.indexOf('Post-onboarding only:')
    expect(onboardIdx).toBeGreaterThan(0)
    expect(stripIdx).toBeGreaterThan(onboardIdx)
  })

  it('gives an onboarding auth-timeout an explicit retry instead of leaving Ready disabled forever', () => {
    const onboardIdx = app.indexOf('Onboarding gate FIRST')
    const authGuardIdx = app.indexOf('if (auth.status === null && auth.bootError)', onboardIdx)
    const retryIdx = app.indexOf('Métis needs to check access', onboardIdx)
    const experienceIdx = app.indexOf('<OnboardingV2', onboardIdx)
    expect(authGuardIdx).toBeGreaterThan(onboardIdx)
    expect(retryIdx).toBeGreaterThan(onboardIdx)
    expect(retryIdx).toBeGreaterThan(authGuardIdx)
    expect(experienceIdx).toBeGreaterThan(retryIdx)
    const recovery = app.slice(authGuardIdx, experienceIdx)
    expect(recovery).toMatch(/void auth\.refresh\(\)/)
    expect(recovery).toMatch(/window\.location\.reload\(\)/)
    expect(recovery).not.toMatch(/\{auth\.bootError\}/)
  })

  it('index.html ships a no-JS exclusive bed so force-show is never pure black', () => {
    expect(indexHtml).toMatch(/#05010A/)
    expect(indexHtml).toMatch(/id="boot-bed"/)
    // Real <img> (not only CSS background) — relative public asset under Electron file://
    expect(indexHtml).toMatch(/id="boot-bed-img"/)
    expect(indexHtml).toMatch(/src=['"]onboarding-hero-poster\.jpg['"]/)
    expect(indexHtml).not.toMatch(/src=['"]\/onboarding-hero-poster\.jpg['"]/)
    expect(ONBOARDING_BOOT_POSTER_HREF).toMatch(/onboarding-hero-poster/)
    // Vite may emit /src/... in unit tests; packaged build hashes under assets/. Never the public root path.
    expect(ONBOARDING_BOOT_POSTER_HREF).not.toBe('/onboarding-hero-poster.jpg')
    expect(ONBOARDING_BOOT_POSTER_HREF).toMatch(/assets\/onboarding-hero-poster/)
  })

  it('keeps the static Act 1 shell hidden unless the exact exclusive startup flag enables it', () => {
    const gate = readFileSync(join(__dirname, '../../public/onboarding-boot-gate.js'), 'utf8')
    const boot = readFileSync(join(__dirname, '../../public/act1-boot.js'), 'utf8')
    expect(indexHtml).toMatch(/#boot-bed,\s*#act1-boot-chrome\s*\{\s*display:\s*none/)
    expect(indexHtml).toMatch(/html\.exclusive-onboarding-boot\s+#boot-bed/)
    expect(indexHtml).toMatch(/html\.exclusive-onboarding-boot\s+#act1-boot-chrome/)
    expect(indexHtml).toMatch(/src="\.\/onboarding-boot-gate\.js"/)
    expect(boot).toMatch(/exclusive-onboarding-boot/)

    const classAdds: string[] = []
    runInNewContext(gate, {
      URLSearchParams,
      location: { search: '?demo=answer' },
      document: { documentElement: { classList: { add: (name: string) => classAdds.push(name) } } }
    })
    expect(classAdds).toEqual([])

    runInNewContext(gate, {
      URLSearchParams,
      location: { search: '?exclusiveOnboarding=1' },
      document: { documentElement: { classList: { add: (name: string) => classAdds.push(name) } } }
    })
    expect(classAdds).toEqual(['exclusive-onboarding-boot'])
  })
})

describe('FITO-185-Z instant Act1 show (no hide-for-seconds)', () => {
  const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8')
  const bootJs = readFileSync(join(__dirname, '../../public/act1-boot.js'), 'utf8')
  const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
  const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')

  it('no-JS shell is poster + Métis wordmark + Next (never waits on video)', () => {
    expect(indexHtml).toMatch(/rel="preload"[^>]*onboarding-hero-poster\.jpg/)
    expect(indexHtml).toMatch(/background-image:\s*url\("onboarding-hero-poster\.jpg"\)/)
    expect(indexHtml).toMatch(/decoding="sync"/)
    expect(indexHtml).not.toMatch(/decoding="async"/)
    expect(indexHtml).toMatch(/id="act1-boot-chrome"/)
    expect(indexHtml).toMatch(/id="act1-boot-wordmark"/)
    expect(indexHtml).toMatch(/Métis/)
    expect(indexHtml).toMatch(/id="act1-boot-next"/)
    expect(indexHtml).toMatch(/act1-boot\.js/)
    expect(indexHtml).not.toMatch(/onboarding-hero-lady-planet/)
  })

  it('act1-boot marks first paint and queues Next without touching the mp4', () => {
    expect(bootJs).toMatch(/act1-first-paint/)
    expect(bootJs).toMatch(/__act1BootNextQueued/)
    expect(bootJs).toMatch(/act1-boot-next/)
    expect(bootJs).not.toMatch(/\.mp4/)
  })

  it('React consumes queued Next and hides the no-JS chrome', () => {
    expect(experience).toMatch(/act1-boot-chrome/)
    expect(experience).toMatch(/act1-boot-next/)
    expect(experience).toMatch(/__act1BootNextQueued/)
  })

  it('exclusive BrowserWindow shows immediately with Act1 shell (FITO-185-Z)', () => {
    expect(main).toMatch(/show:\s*true/)
    expect(main).not.toMatch(/show:\s*!onboardingLive/)
    expect(main).toMatch(/FITO-185-Z/)
    expect(main).toMatch(/pollAct1Paint/)
    expect(main).toMatch(/ACT1_SHELL_READY/)
    expect(main).not.toMatch(/Hero hold `#05010A` is the first frame/)
  })

  it('hero video is deferred off the first-paint path', () => {
    expect(experience).toMatch(/FITO-185-Y: poster\/UI first/)
    expect(experience).toMatch(/setTimeout\(start, 480\)/)
    expect(experience).toMatch(/decoding="sync"/)
  })
})

describe('FITO-185-J electron file paths', () => {
  it('boot poster uses Vite asset import, not a leading-slash public path', () => {
    const bootSrc = readFileSync(join(__dirname, './onboarding-boot.ts'), 'utf8')
    expect(bootSrc).toMatch(/import bootPosterUrl from '\.\.\/assets\/onboarding-hero-poster\.jpg'/)
    expect(bootSrc).not.toMatch(/ONBOARDING_BOOT_POSTER_HREF = '\/onboarding-hero-poster\.jpg'/)
  })

  it('exclusive overlay chrome stays opaque #05010A', () => {
    const geo = readFileSync(join(__dirname, '../../../main/island/geometry.ts'), 'utf8')
    expect(geo).toMatch(/EXCLUSIVE_ONBOARDING_BACKGROUND = '#05010A'/)
    expect(geo).toMatch(/if \(onboardingLive\)[\s\S]*?transparent: false/)
  })
})

describe('FITO-185-N exclusiveOnboarding flag', () => {
  it('reads exclusiveOnboarding=1 from search', () => {
    expect(exclusiveOnboardingFlag('?exclusiveOnboarding=1')).toBe(true)
    expect(exclusiveOnboardingFlag('?shotbg=dark')).toBe(false)
    expect(exclusiveOnboardingFlag('')).toBe(false)
  })

  it('forces Act 1 while exclusive flag set even if settings claim done', () => {
    const done = { ...provisionalOnboardingSettings(), onboardingDone: true }
    expect(isOnboardingBoot(done, '?exclusiveOnboarding=1')).toBe(true)
  })

  it('releases Act 1 when done and flag absent (post-recreate)', () => {
    const done = { ...provisionalOnboardingSettings(), onboardingDone: true }
    expect(isOnboardingBoot(done, '')).toBe(false)
  })

  it('main createWindow stamps exclusiveOnboarding on packaged file URL too', () => {
    const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')
    expect(main).toMatch(/function overlayRendererUrl\(\): string/)
    expect(main).toMatch(/const onboardingLive = onboardingExclusiveLive\(\)/)
    expect(main).toMatch(/if \(onboardingLive\) params\.set\('exclusiveOnboarding'/)
    // The helper always starts from either the dev URL or the packaged file URL, then adds the flag.
    expect(main).toMatch(/process\.env\['ELECTRON_RENDERER_URL'\] \?\? pathToFileURL/)
    expect(main).toMatch(/const rendererUrl = overlayRendererUrl\(\)/)
    expect(main).toMatch(/win\.loadURL\(rendererUrl\)/)
    expect(main).toMatch(/self\.loadURL\(overlayRendererUrl\(\)\)/)
  })
})

describe('FITO-185-T exclusive Act 1 music after interactive', () => {
  it('OnboardingExperience gates Goldberg start on window focus (not mount-only)', () => {
    const experience = readFileSync(
      join(__dirname, '../components/OnboardingExperience.tsx'),
      'utf8'
    )
    expect(experience).toMatch(/FITO-185-T: do not start Goldberg until Act 1 is interactive/)
    expect(experience).toMatch(/document\.hasFocus\(\)/)
    expect(experience).toMatch(/addEventListener\('focus'/)
    // Mount effect must not fire music.start before the focus/fallback gate.
    const mount = experience.slice(
      experience.indexOf('FITO-185-T: do not start Goldberg'),
      experience.indexOf('Demo/Bar/Three chunks')
    )
    expect(mount).toMatch(/kickMusic/)
    expect(mount.indexOf('kickMusic')).toBeLessThan(mount.indexOf("music.start()"))
  })

  it('main exclusive reveal uses showForExclusiveOnboarding under FITO-185-S (no SFS)', () => {
    const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')
    expect(main).toMatch(/FITO-185-T: Electron 43\+ never SFS/)
    expect(main).toMatch(/showForExclusiveOnboarding\(win\)/)
    expect(main).toMatch(/showForExclusiveOnboarding\(overlay\)/)
    expect(main).toMatch(/exclusiveOsFullscreenAllowed/)
  })
})


describe('FITO-185-X post-boot Loading never forever', () => {
  const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')
  const state = readFileSync(join(__dirname, '../state.ts'), 'utf8')

  it('Loading strip offers Reload after soft wait and on bootError', () => {
    expect(app).toMatch(/bootSlow/)
    expect(app).toMatch(/FITO-185-X: mid-wait Reload/)
    expect(state).toMatch(/BOOT_SOFT_RETRY_MS = 5_000/)
    expect(app).toMatch(/Métis couldn’t start/)
  })

  it('registerIpc runs before createWindow so settings IPC exists pre-loadURL', () => {
    const ipc = main.indexOf("runStep('registerIpc', registerIpc)")
    const win = main.indexOf("runStep('createWindow', createWindow)")
    expect(ipc).toBeGreaterThan(-1)
    expect(win).toBeGreaterThan(ipc)
  })

  it('licenseGate boot fetch fails open on timeout', () => {
    expect(app).toMatch(/FITO-185-X: bound license:gate/)
    expect(app).toMatch(/failOpen/)
  })
})
