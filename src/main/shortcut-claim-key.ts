/** Electron accepts several spellings for the same macOS modifier. Claim one canonical form so a
 * hand-edited shortcut cannot replace the reserved emergency quit callback through an alias. */
export function shortcutClaimKey(accel: string): string {
  if (process.platform !== 'darwin') return accel
  return accel
    .split('+')
    .map((part) => {
      const token = part.trim().toLowerCase()
      if (
        token === 'command' ||
        token === 'cmd' ||
        token === 'meta' ||
        token === 'super' ||
        token === 'commandorcontrol' ||
        token === 'cmdorctrl'
      )
        return 'command'
      if (token === 'control' || token === 'ctrl') return 'control'
      if (token === 'escape' || token === 'esc') return 'escape'
      return token
    })
    .sort()
    .join('+')
}
