export type AdminPolicyIdentity = { path: string; mtime: number; dev: number; ino: number }
type Snapshot = AdminPolicyIdentity & { at: number; content: string | null }

/** Pure cache policy; the existing store owns legacy filesystem and verified-fd reads. */
export class AdminManagedCache {
  private snapshot: Snapshot | null = null
  constructor(
    private readonly dependencies: {
      readIdentity: () => AdminPolicyIdentity
      readTrusted: () => string | null
      now?: () => number
    }
  ) {}

  reset(): void {
    this.snapshot = null
  }

  read(): string | null {
    const id = this.dependencies.readIdentity()
    const now = this.dependencies.now?.() ?? Date.now()
    const cached = this.snapshot
    if (
      cached &&
      cached.path === id.path &&
      cached.mtime === id.mtime &&
      cached.dev === id.dev &&
      cached.ino === id.ino &&
      now - cached.at >= 0 &&
      now - cached.at < 60_000
    )
      return cached.content
    const content = this.dependencies.readTrusted()
    this.snapshot = { ...id, at: now, content }
    return content
  }
}
