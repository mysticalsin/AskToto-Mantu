/**
 * Spotlight Ref success stories for the follow-up email. A self-contained ask on its own id, pinned to the
 * managed Dust agent, so it never pollutes the live answer, suggest or follow-up streams. Resolves to ''
 * on any failure and never hangs the email waiting on the lookup.
 */
export async function fetchSpotlightWinsFrom(refAgent: string, topic: string): Promise<string> {
  const id = `wins-${Date.now()}`
  return new Promise<string>((resolve) => {
    let text = ''
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      offDelta()
      offDone()
      offErr()
      resolve(value)
    }
    const offDelta = window.toto.onDelta((d) => {
      if (d.id === id) text += d.text
    })
    const offDone = window.toto.onDone((d) => {
      if (d.id === id) finish(text.trim())
    })
    const offErr = window.toto.onError((e) => {
      if (e.id === id) finish('')
    })
    window.toto
      .ask({
        id,
        mode: 'answer',
        prompt:
          `From our reference library, list up to 3 REAL customer wins or case studies relevant to: ${topic}. ` +
          `For each, one line: the customer (or "a comparable customer" if it must stay anonymous), the result, and why it fits. ` +
          `Only genuine references from the library. Never invent one. If nothing clearly fits, reply with the single word NONE.`,
        agentOverride: refAgent,
        providerOverride: 'dust',
        history: []
      })
      .catch(() => finish(''))
    // Safety net: never hang the email waiting on a wins lookup.
    setTimeout(() => finish(text.trim()), 30_000)
  })
}
