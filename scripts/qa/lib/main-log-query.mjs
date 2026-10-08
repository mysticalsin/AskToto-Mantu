/** The candidate's main.log path, synchronously resolved without reading the file. */
const MAIN_LOG_PATH = `(() => {
  const load = process.mainModule?.require
  if (typeof load !== 'function') return {
    error: 'process.mainModule.require is unavailable in the compiled main',
    retry: 'loader-unavailable'
  }
  try {
    return { path: load('node:path').join(load('electron').app.getPath('logs'), 'main.log') }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()`

/** Keep loader-readiness waits on the host within one budget. Awaiting this synchronous value inside V8
 * can lose the inspector-created promise to collection; async ST-1 measurements retain their pinned evaluator. */
export async function queryMainLogPath(cdp, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let remaining = timeoutMs
  let result = { late: true }
  while (remaining > 0) {
    const answer = await cdp.send('Runtime.evaluate', { expression: MAIN_LOG_PATH, returnByValue: true }, remaining)
    if (answer.late) return answer
    if (answer.result.exceptionDetails) throw new Error(answer.result.exceptionDetails.text)
    result = { late: false, value: answer.result.result?.value }
    if (result.value?.retry !== 'loader-unavailable') return result
    remaining = deadline - performance.now()
    if (remaining <= 0) return result
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)))
    remaining = deadline - performance.now()
  }
  return result
}
