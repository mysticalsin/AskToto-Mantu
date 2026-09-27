/**
 * Kernel-blocking file fixtures for the storage stall tests: gateway.test.ts, ST-1 (scripts/qa/st-1.mjs)
 * and the freeze repro (M2-0008). POSIX only; Windows has no FIFOs.
 *
 * Opening a FIFO for reading blocks in the kernel until a writer opens it, the way reading a cloud-only
 * file blocks while the provider downloads it: the libuv pool thread running the read stays pinned until
 * the fixture is released. A JavaScript delay cannot stand in for this, because it never occupies a pool
 * thread.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'

/** Creates a FIFO at `path`, readable and writable by the owner only. */
export function createFifo(path) {
  execFileSync('mkfifo', ['-m', '600', path])
}

/**
 * Wakes every reader blocked opening the FIFO at `path`: opens the write end without blocking and closes
 * it, so each waiting read sees end-of-file. Returns whether any reader was waiting (ENXIO: none was).
 * A read queued behind a pinned pool thread opens the FIFO only later, so callers repeat this until their
 * reads settle.
 */
export function releaseFifo(path) {
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ENXIO') return false
    throw error
  }
  closeSync(fd)
  return true
}
