import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY_ORB_STYLE,
  OVERLAY_ORB_COPY,
  OVERLAY_ORB_STYLES,
  overlayOrbRestIsCircle,
  overlayUsesObsidianOrb,
  overlayUsesJarvisOrb,
  overlayOrbPickerSelected,
  OVERLAY_ORB_PICKER_CARDS,
  parseOverlayOrbStyle
} from './overlay-orb'
import { overlayAllowsMinimize, overlayShowsBarOrb, overlayDocksBarCircle } from './overlay-chrome'

describe('orb selection persist + Bar-only law', () => {
  it('default is full bar; garbage parses to bar', () => {
    expect(DEFAULT_OVERLAY_ORB_STYLE).toBe('bar')
    expect(OVERLAY_ORB_STYLES).toEqual(['bar', 'jakub', 'obsidian'])
    expect(parseOverlayOrbStyle(undefined)).toBe('bar')
    expect(parseOverlayOrbStyle('nope')).toBe('bar')
    expect(parseOverlayOrbStyle('obsidian')).toBe('obsidian')
    expect(parseOverlayOrbStyle('jakub')).toBe('jakub')
  })

  it('Hide and Island never show a circle even if the orb style is set', () => {
    expect(overlayOrbRestIsCircle('hide', 'jakub')).toBe(false)
    expect(overlayOrbRestIsCircle('island', 'obsidian')).toBe(false)
    expect(overlayOrbRestIsCircle('bar', 'jakub')).toBe(true)
    expect(overlayOrbRestIsCircle('bar', 'obsidian')).toBe(true)
    expect(overlayOrbRestIsCircle('bar', 'bar')).toBe(false)
    expect(overlayUsesJarvisOrb('bar')).toBe(true)
    expect(overlayUsesJarvisOrb('hide')).toBe(false)
    expect(overlayUsesObsidianOrb('bar', 'obsidian')).toBe(true)
    expect(overlayUsesObsidianOrb('bar', 'jakub')).toBe(true)
    expect(overlayUsesObsidianOrb('hide', 'obsidian')).toBe(false)
    expect(OVERLAY_ORB_PICKER_CARDS).toEqual(['bar', 'obsidian'])
    expect(overlayOrbPickerSelected('jakub')).toBe('obsidian')
    expect(overlayOrbPickerSelected('bar')).toBe('bar')
    expect(overlayShowsBarOrb('hide', true)).toBe(false)
    expect(overlayShowsBarOrb('island', true)).toBe(false)
    expect(overlayAllowsMinimize('hide')).toBe(false)
    expect(overlayDocksBarCircle('hide')).toBe(false)
  })

  it('Settings captions have no em dash and no Vibe Island', () => {
    const all = Object.values(OVERLAY_ORB_COPY)
      .map((c) => `${c.title} ${c.desc}`)
      .join(' ')
    expect(all).not.toMatch(/\u2014/)
    expect(all).not.toMatch(/Vibe Island/)
    expect(OVERLAY_ORB_COPY.bar.desc).toMatch(/bar stays on screen/)
    expect(OVERLAY_ORB_COPY.obsidian.title).toBe('Circle')
    expect(OVERLAY_ORB_COPY.jakub.title).toBe('Circle')
    expect(OVERLAY_ORB_COPY.obsidian.desc).toMatch(/Jarvis particle orb/)
    expect(all).not.toMatch(/Obsidian/)
    expect(all).not.toMatch(/Jarvis \/ Obsidian/)
  })
})
