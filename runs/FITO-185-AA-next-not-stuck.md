# FITO-185-AA — Next click advances (never covered by static Act1)

**Date:** 2026-09-15 ~5:58pm ET  
**Branch:** release/1.9.1

## Root cause
`#act1-boot-chrome { display: flex }` (id specificity) overrode UA `[hidden] { display: none }`.
HeroWelcome's `setAttribute('hidden', '')` was a no-op. Static Métis+Next stayed `z-index: 2` over `#root` (`z-index: 1`).
Tony clicked Next and Act 2 ran underneath (or queue only) while the static shell stayed forever — felt like Loading / nothing happens.

## Fix
1. `#act1-boot-chrome[hidden] { display: none !important; ... }`
2. `#root { z-index: 3 }`
3. `act1-boot.js` retires chrome when `#root` gets children / on Next after React
4. HeroWelcome hard-hides chrome via style.display=none
5. `onBegin` calls `setScene('problem')` first

## Prove
Pack Metis-<sha>-qa; click Next; Act 2 (problem story + Continue) must be visible.
