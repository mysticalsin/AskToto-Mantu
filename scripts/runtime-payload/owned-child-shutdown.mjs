function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForSpawn(child, timeoutMs) {
  if (child.pid !== undefined) return Promise.resolve('spawned')
  return new Promise((resolve) => {
    let complete = false
    const finish = (state) => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      resolve(state)
    }
    const onSpawn = () => finish('spawned')
    const onError = () => finish('failed')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function waitForExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let complete = false
    const finish = (hasExited) => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('close', onClose)
      child.off('error', onError)
      resolve(hasExited)
    }
    const onExit = () => finish(exited(child))
    const onClose = () => finish(exited(child))
    const onError = () => {
      // A failed kill is not evidence that the process exited; let the bounded wait escalate.
    }
    const timer = setTimeout(() => {
      if (complete) return
      complete = true
      child.off('exit', onExit)
      child.off('close', onClose)
      child.off('error', onError)
      resolve(exited(child))
    }, timeoutMs)
    child.once('exit', onExit)
    child.once('close', onClose)
    child.on('error', onError)
  })
}

/** Stop only the ChildProcess handle supplied by its owner; never report success before exit/close. */
export async function stopOwnedChild(child, { spawnMs = 5_000, termMs = 3_000, killMs = 3_000 } = {}) {
  const spawnState = await waitForSpawn(child, spawnMs)
  if (spawnState === 'failed') return
  if (spawnState !== 'spawned') {
    child.once('spawn', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // A late spawn must still be terminated even though the owner is already failing closed.
      }
    })
    try {
      child.kill('SIGKILL')
    } catch {
      // The caller receives a fixed failure while the late-spawn handler retains exact ownership.
    }
    throw new Error('RUNTIME_CHILD_SPAWN_STATE_UNCONFIRMED')
  }
  if (exited(child)) return
  const onError = () => {
    // Kill errors are handled by the bounded exit checks and escalation below.
  }
  child.on('error', onError)
  try {
    child.kill('SIGTERM')
  } catch {
    // A later bounded wait and SIGKILL remain authoritative.
  }
  if (await waitForExit(child, termMs)) {
    child.off('error', onError)
    return
  }
  if (!exited(child)) {
    try {
      child.kill('SIGKILL')
    } catch {
      // The final bounded exit check reports failure if this owned child remains alive.
    }
  }
  const stopped = await waitForExit(child, killMs)
  child.off('error', onError)
  if (!stopped) throw new Error('RUNTIME_CHILD_EXIT_UNCONFIRMED')
}
