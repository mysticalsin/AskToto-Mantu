import { basename, sep } from 'node:path'

/** The one installer a lean measurement is about: the unsigned DMG, or the Windows Setup (not the Portable). */
export function selectLeanInstallers(paths, target) {
  return paths.filter((path) => {
    const name = basename(path).toLowerCase()
    if (path.includes(`${sep}win-unpacked${sep}`)) return false
    return target === 'mac' ? name.endsWith('.dmg') : /^metis-setup-.*\.exe$/.test(name)
  })
}
