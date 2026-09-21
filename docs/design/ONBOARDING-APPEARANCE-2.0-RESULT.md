# Onboarding Appearance 2.0 RESULT

**Tip:** (this commit) on `claude/cap4-motion` after `318e0ab2`  
**When:** 2026-09-20 ~8:07pm ET

## Flow
1. **Where should Métis sit?** Top | Right → persists `overlayPlacement`
2. **How should it look?** chrome cards by placement → persists `overlayLayout` + `autoHideOverlay` + `overlayOrbStyle`

### Top chrome
Hidden (default) | Full bar that hides | Full bar that stays | Circle | Jarvis circle

### Right chrome
Dock (default) | Full bar that hides | Full bar that stays | Circle | Jarvis circle

Island omitted from onboarding (Settings still has it).

## Mapping notes
- `bar-hides` → `bar` + `autoHideOverlay: true` + orb `bar`
- `bar-stays` → `bar` + `autoHideOverlay: false` + orb `bar`
- `circle` → `bar` + jakub; `jarvis` → `bar` + obsidian
- `dock` → `dock` + `autoHideOverlayForLayout('dock')`

Live preview key=`placement:layout:orb:chromeId`. Pack HOLD.
