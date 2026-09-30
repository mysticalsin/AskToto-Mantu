import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type { RendererView } from '@shared/renderer-view'
import { NavigationGuardService, type NavigationGuardRequest } from '../../lib/navigation-guard'
import { onboardingLaunchFromSearch } from '../../lib/onboarding-launch'

type SettingsInitialTab = 'personalize' | 'calendar' | 'ai' | undefined

type UseViewRouterOptions = {
  setCollapsed: (collapsed: boolean) => void
  setMinimized: (minimized: boolean) => void
}

function initialViewFromLaunch(): RendererView {
  if (typeof location === 'undefined') return 'answer'
  return onboardingLaunchFromSearch(location.search).view
}

function initialSettingsTabFromLaunch(): 'ai' | undefined {
  if (typeof location === 'undefined') return undefined
  return onboardingLaunchFromSearch(location.search).settingsTab
}

export function useViewRouter({
  setCollapsed,
  setMinimized
}: UseViewRouterOptions): {
  view: RendererView
  setView: (v: RendererView | ((prev: RendererView) => RendererView)) => void
  setViewRaw: (v: RendererView | ((prev: RendererView) => RendererView)) => void
  settingsInitialTab: SettingsInitialTab
  settingsNotice: string | undefined
  openSettings: (tab?: SettingsInitialTab, notice?: string) => void
  openSettingsDefault: () => void
  navigationGuard: NavigationGuardService
  setNavigationReveal: (reveal: () => void) => void
  navigationGuardRequest: NavigationGuardRequest | null
  onReviewDirtyChange: (dirty: boolean, save?: () => Promise<boolean>) => void
  confirmReviewNavigation: () => Promise<boolean>
  guardReviewNav: (proceed: () => void) => void
} {
  const [view, setViewRaw] = useState<RendererView>(initialViewFromLaunch)
  const setView = useCallback((v: RendererView | ((prev: RendererView) => RendererView)): void => {
    startTransition(() => setViewRaw(v))
  }, [])
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsInitialTab>(initialSettingsTabFromLaunch)
  const [settingsNotice, setSettingsNotice] = useState<string | undefined>(undefined)

  const openSettings = useCallback((tab?: SettingsInitialTab, notice?: string): void => {
    setSettingsInitialTab(tab)
    setSettingsNotice(notice)
    setMinimized(false)
    void window.toto.minimize(false)
    setView('settings')
    setCollapsed(false)
  }, [setCollapsed, setMinimized, setView])

  const openSettingsDefault = useCallback((): void => {
    setSettingsInitialTab(undefined)
    setSettingsNotice(undefined)
    setView((v) => (v === 'settings' ? 'answer' : 'settings'))
    setCollapsed(false)
  }, [setCollapsed, setView])

  const navigationGuardRef = useRef<NavigationGuardService | null>(null)
  if (!navigationGuardRef.current) navigationGuardRef.current = new NavigationGuardService()
  const navigationGuard = navigationGuardRef.current
  const setNavigationReveal = useCallback((reveal: () => void): void => navigationGuard.setReveal(reveal), [navigationGuard])
  const [navigationGuardRequest, setNavigationGuardRequest] = useState<NavigationGuardRequest | null>(() => navigationGuard.current())
  useEffect(() => navigationGuard.subscribe(() => setNavigationGuardRequest(navigationGuard.current())), [navigationGuard])

  const reviewDirtyRef = useRef<{ dirty: boolean; save?: () => Promise<boolean> }>({ dirty: false })
  const onReviewDirtyChange = useCallback((dirty: boolean, save?: () => Promise<boolean>): void => {
    reviewDirtyRef.current = { dirty, save }
  }, [])
  const viewRef = useRef(view)
  viewRef.current = view

  const confirmReviewNavigation = useCallback(async (): Promise<boolean> => {
    if (viewRef.current !== 'review' || !reviewDirtyRef.current.dirty) return true
    const choice = await navigationGuard.request({
      title: 'Save recap changes?',
      message: 'You have unsaved edits in this recap. Save them before leaving, discard them, or cancel to keep editing.',
      saveLabel: 'Save',
      discardLabel: 'Discard',
      cancelLabel: 'Cancel',
      destructive: true
    })
    if (choice === 'cancel') return false
    if (choice === 'save') return reviewDirtyRef.current.save ? reviewDirtyRef.current.save() : false
    return true
  }, [navigationGuard])

  const guardReviewNav = useCallback((proceed: () => void): void => {
    void (async () => {
      if (!(await confirmReviewNavigation())) return
      proceed()
    })()
  }, [confirmReviewNavigation])
  return {
    view,
    setView,
    setViewRaw,
    settingsInitialTab,
    settingsNotice,
    openSettings,
    openSettingsDefault,
    navigationGuard,
    setNavigationReveal,
    navigationGuardRequest,
    onReviewDirtyChange,
    confirmReviewNavigation,
    guardReviewNav
  }
}
