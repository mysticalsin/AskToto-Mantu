import { execFileSync } from 'node:child_process'

/** Raw `vm_stat` output (macOS page counters from host_statistics64). Throws when it cannot run. */
export function readVmStat(): string {
  return execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2_000 })
}
