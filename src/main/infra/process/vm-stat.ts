import { execFile } from 'node:child_process'

/** Raw `vm_stat` output (macOS page counters from host_statistics64). Rejects when it cannot run.
 *  Asynchronous on purpose (M2-0422): callers sit on the main thread, and a stalled vm_stat must not freeze it. */
export function readVmStat(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 2_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })
}
