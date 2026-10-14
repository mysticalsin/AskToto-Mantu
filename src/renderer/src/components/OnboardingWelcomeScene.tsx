import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { MetisMark } from './MetisMark'
import { requestOnboardingPortalOpen } from '../lib/onboarding-portal'
import {
  ONBOARDING_HERO_POSTER_SRC,
  ONBOARDING_HERO_VIDEO_SRC,
  preloadOnboardingHeroVideo,
  resolveOnboardingHeroVideoSrc
} from '../lib/onboarding-hero-video'

const WORDMARK = 'Métis'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function OnboardingHeroVideo({ videoRef }: { videoRef: Ref<HTMLVideoElement> }): JSX.Element {
  const [videoFailed, setVideoFailed] = useState(false)
  const [allowVideo, setAllowVideo] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const markReady = useCallback(() => setVideoReady(true), [])
  useEffect(() => {
    if (prefersReducedMotion()) return
    const start = (): void => setAllowVideo(true)
    const timer = window.setTimeout(start, 480)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!allowVideo || prefersReducedMotion()) return
    preloadOnboardingHeroVideo()
    const element = typeof videoRef === 'object' && videoRef ? videoRef.current : null
    if (element) {
      element.load()
      void element.play().catch(() => {})
    }
    const fallback = window.setTimeout(() => {
      const current = typeof videoRef === 'object' && videoRef ? videoRef.current : null
      if (current && (current.currentTime > 0 || current.readyState >= 2)) setVideoReady(true)
    }, 800)
    return () => {
      window.clearTimeout(fallback)
      element?.pause()
    }
  }, [allowVideo, videoRef])
  return (
    <div className="onboard-hero-video" aria-hidden="true">
      <img
        className="onboard-hero-poster"
        src={ONBOARDING_HERO_POSTER_SRC}
        alt=""
        decoding="sync"
        fetchPriority="high"
      />
      {allowVideo && !prefersReducedMotion() && !videoFailed && (
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          poster={ONBOARDING_HERO_POSTER_SRC}
          src={resolveOnboardingHeroVideoSrc(ONBOARDING_HERO_VIDEO_SRC)}
          className={videoReady ? 'onboard-hero-video--ready' : 'onboard-hero-video--pending'}
          onLoadedData={markReady}
          onCanPlay={markReady}
          onPlaying={markReady}
          onTimeUpdate={markReady}
          onError={() => setVideoFailed(true)}
        />
      )}
      <div className="onboard-hero-video-tint" />
    </div>
  )
}

export function HeroWelcome({ onBegin }: { onBegin: () => void }): JSX.Element {
  const onBeginRef = useRef(onBegin)
  onBeginRef.current = onBegin
  useLayoutEffect(() => {
    requestOnboardingPortalOpen()
    document.getElementById('act1-boot-chrome')?.remove()
    const bootWindow = window as Window & { __act1BootNextQueued?: boolean }
    if (bootWindow.__act1BootNextQueued) {
      bootWindow.__act1BootNextQueued = false
      onBeginRef.current()
    }
    const onQueued = (): void => {
      bootWindow.__act1BootNextQueued = false
      onBeginRef.current()
    }
    window.addEventListener('act1-boot-next', onQueued)
    return () => window.removeEventListener('act1-boot-next', onQueued)
  }, [])
  return (
    <>
      <div className="hero-welcome relative z-10 flex flex-col items-center gap-5">
        <div className="scene-enter flex flex-col items-center gap-5">
          <div className="hero-mark onboard-mark-land" aria-hidden="true">
            <MetisMark size={96} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <h1
              className="hero-wordmark fade-up m-0 select-none"
              aria-label={WORDMARK}
              style={{ fontFamily: 'var(--font-ui)', animationDelay: '160ms', animationFillMode: 'both' }}
            >
              <span aria-hidden="true">{WORDMARK}</span>
            </h1>
            <p
              className="hero-tagline fade-up m-0 text-[14px] text-[color:var(--color-ink-2)]"
              style={{ animationDelay: '400ms', animationFillMode: 'both' }}
            >
              Your on-device meeting copilot.
            </p>
          </div>
        </div>
        <button type="button" onClick={onBegin} className="onboard-cta no-drag focus-ring">
          Next
        </button>
        <p
          className="hero-byline onboard-glass onboard-glass-chip fade-up m-0 text-[10px] tracking-wide"
          style={{ animationDelay: '1300ms', animationFillMode: 'backwards' }}
        >
          Mantu ·{' '}
          <a
            href="https://www.linkedin.com/in/tonywalteur/"
            target="_blank"
            rel="noopener noreferrer"
            className="hero-byline-link no-drag focus-ring"
          >
            Metis Maintainers
          </a>
        </p>
      </div>
    </>
  )
}
