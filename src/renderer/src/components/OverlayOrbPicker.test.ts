import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_ORB_COPY, OVERLAY_ORB_STYLES } from '@shared/overlay-orb'

const picker = readFileSync(join(__dirname, './OverlayOrbPicker.tsx'), 'utf8')
const settings = readFileSync(join(__dirname, './Settings.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const orb = readFileSync(join(__dirname, './ObsidianOrb.tsx'), 'utf8')
const design = readFileSync(join(__dirname, '../../../../docs/design/ORB-SELECTION.md'), 'utf8')

describe('Settings Bar rest orb cards', () => {
  it('renders Full bar, Circle, and Obsidian with the reference look', () => {
    expect(OVERLAY_ORB_STYLES).toEqual(['bar', 'jakub', 'obsidian'])
    expect(picker).toMatch(/aria-label="Bar rest"/)
    expect(picker).toMatch(/data-orb-diagram=\{id\}/)
    expect(settings).toMatch(/<OverlayOrbPicker/)
    expect(settings).toMatch(/overlayOrbStyle: id/)
    expect(settings).toMatch(/Applies when Overlay chrome is Bar/)
    expect(css).toMatch(/\.overlay-orb-diagram--bar/)
    expect(css).toMatch(/\.obsidian-orb__canvas/)
    expect(css).not.toMatch(/\.obsidian-orb__spark/)
    expect(css).not.toMatch(/\.obsidian-orb__ring/)
    expect(orb).toMatch(/data-orb-style="obsidian"/)
    expect(orb).toMatch(/data-orb-engine="jarvis-particles"/)
    expect(orb).toMatch(/obsidian-orb__canvas/)
    expect(orb).not.toMatch(/obsidian-orb__spark/)
    expect(OVERLAY_ORB_COPY.bar.title).toBe('Full bar')
    expect(OVERLAY_ORB_COPY.obsidian.title).toMatch(/Jarvis \/ Obsidian/)
    expect(OVERLAY_ORB_COPY.obsidian.desc).toMatch(/particle orb/)
    expect(picker).toMatch(/id === 'bar' \? <span className="overlay-chrome-card__default">Default<\/span>/)
    expect(design).toMatch(/DESIGN before UI/)
    expect(design).toMatch(/0x4ca8e8/)
    expect(design).toMatch(/Do not replace default with Jarvis/)
    const copy = Object.values(OVERLAY_ORB_COPY)
      .map((c) => `${c.title} ${c.desc}`)
      .join(' ')
    expect(copy).not.toMatch(/\u2014/)
  })
})
