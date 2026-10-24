/** Plain numeric semver compare ('1.10.0' > '1.9.2'), leading 'v' tolerated, missing parts = 0.
 *  Prerelease suffixes are ignored on purpose — the releases feed only ever carries plain x.y.z tags. */
export function isNewerVersion(latest: string, current: string): boolean {
  const norm = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((p) => Number.parseInt(p, 10) || 0)
  const a = norm(latest)
  const b = norm(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}
