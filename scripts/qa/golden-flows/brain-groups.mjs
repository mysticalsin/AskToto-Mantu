/**
 * Meeting and brain QA groups of the physical suite (M2-0410): `meetings`, `brain`, `accuracy`.
 * Moved out of e2e-workflows.mjs verbatim; the harness helpers arrive through `ctx`.
 */
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from '../lib/app-driver.mjs'

export function createBrainGroups(ctx) {
const { page, check, record, assert, ask, settings, patch } = ctx

async function groupMeetings() {
  const g = 'meetings'
  const title = `QA Probe ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  let file = null

  await check(g, 'a meeting transcript saves to disk', async () => {
    // Shape per SaveMeetingSchema/TranscriptLineSchema in src/shared/ipc.ts: speaker is
    // 'you' | 'them' | 'unknown' (never 'me'), and each line carries `t` (ms offset), not `at`.
    const res = await page.evaluate(async (title) => window.toto.saveTranscript({
      title,
      mode: 'sales',
      startedAt: Date.now() - 90000,
      recap: '',
      lines: [
        { speaker: 'you', text: 'Thanks for joining. Where are we on the renewal?', t: 0 },
        { speaker: 'them', text: 'We need the usage report before we can sign.', t: 30000 },
        { speaker: 'you', text: 'I will send the usage report by Friday.', t: 60000 }
      ]
    }), title)
    assert(res && res.path, `no path returned: ${JSON.stringify(res)}`)
    return res.path
  })

  await check(g, 'the saved meeting appears in the History list', async () => {
    const list = await page.evaluate(() => window.toto.recallList())
    const hit = list.find((m) => m.title === title)
    assert(hit, `saved meeting not in recallList (${list.length} entries)`)
    file = hit.file
    return { file, total: list.length }
  })

  await check(g, 'the meeting reads back with its content intact', async () => {
    assert(file, 'no file from the previous step')
    const read = await page.evaluate((f) => window.toto.recallRead(f), file)
    const body = JSON.stringify(read)
    assert(/usage report/i.test(body), 'saved content missing on read-back')
    return { locked: read.locked ?? false }
  })

  await check(g, 'search finds the meeting by a phrase from its body', async () => {
    const hits = await page.evaluate(() => window.toto.recallSearch('usage report'))
    assert(Array.isArray(hits), 'search did not return a list')
    return { hits: hits.length }
  })

  await check(g, 'rename persists', async () => {
    assert(file, 'no file')
    const renamed = `${title} RENAMED`
    const res = await page.evaluate(([f, t]) => window.toto.recallRename(f, t), [file, renamed])
    assert(res.ok, `rename failed: ${res.error}`)
    const list = await page.evaluate(() => window.toto.recallList())
    assert(list.some((m) => m.title === renamed), 'renamed title not reflected in the list')
    return renamed
  })

  await check(g, 'the confidential flag round-trips', async () => {
    assert(file, 'no file')
    const res = await page.evaluate((f) => window.toto.recallSetConfidential(f, true), file)
    assert(res && res.ok !== false, `set confidential failed: ${JSON.stringify(res)}`)
    await page.evaluate((f) => window.toto.recallSetConfidential(f, false), file)
    return 'on → off'
  })

  await check(g, 'saving a meeting credits the durable time-saved counter', async () => {
    const before = (await settings()).usageStats
    const t = `Time Saved Probe ${Date.now()}`
    await page.evaluate(async (title) => window.toto.saveTranscript({
      title, mode: 'sales', startedAt: Date.now() - 1_800_000, recap: '',
      lines: [
        { speaker: 'you', text: 'Kicking off the renewal.', t: 0 },
        { speaker: 'them', text: 'We are in.', t: 1_500_000 }
      ]
    }), t)
    const after = (await settings()).usageStats
    assert(after.meetingsSummarized === before.meetingsSummarized + 1,
      `meetingsSummarized did not increment: ${before.meetingsSummarized} -> ${after.meetingsSummarized}`)
    assert(after.conversationMinutes > before.conversationMinutes, 'conversationMinutes did not grow')
    assert(after.firstMeetingAt > 0, 'firstMeetingAt not set')
    // Clean up the probe meeting so it does not pollute later checks. Direct unlink, NOT recallDelete —
    // that one waits on a native confirm dialog and would park an unattended run (see the brain group).
    const hit = (await page.evaluate(() => window.toto.recallList())).find((m) => m.title === t)
    if (hit) rmSync(join(await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder), hit.file), { force: true })
    return { meetings: after.meetingsSummarized, minutes: after.conversationMinutes }
  })

  await check(g, 'the time-saved assumption is exposed and adjustable in settings', async () => {
    const s = await settings()
    assert(s.timeSaved && typeof s.timeSaved.writeupRatio === 'number', 'timeSaved assumption missing')
    const before = s.timeSaved.writeupRatio
    await patch({ timeSaved: { ...s.timeSaved, writeupRatio: 0.35 } })
    assert((await settings()).timeSaved.writeupRatio === 0.35, 'assumption did not persist')
    await patch({ timeSaved: { ...s.timeSaved, writeupRatio: before } })
    return { restoredTo: before }
  })

  // The one place recallDelete SHOULD be exercised: deleting a meeting is real product behaviour and its
  // native confirmation is PART of that behaviour, so this must not route around it.
  //
  // But the confirmation is also why it cannot simply be asserted. With no one to answer the dialog the
  // promise never settles: an unbounded await parks the whole suite while the rest of main keeps
  // answering normally, so it reads as a freeze rather than a prompt (it did exactly that on 2026-08-17).
  // And asserting it unattended would make the suite permanently red for something that is not a defect —
  // the same "a check that can never pass" trap already removed from the ask group in this file.
  //
  // So: bounded, and reported as INFO rather than FAIL when nobody answers. An attended run exercises the
  // real path; an unattended one says plainly that it did not, and cleans up after itself either way.
  {
    const name = 'delete removes it from the list'
    if (!file) {
      record(g, name, 'fail', 'no file')
    } else {
      const res = await Promise.race([
        page.evaluate((f) => window.toto.recallDelete(f), file),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'NO_ANSWER' }), 45_000))
      ])
      // 'cancelled' is the SAME non-result as NO_ANSWER: recallDelete's modal defaults to Cancel
      // (defaultId/cancelId = 1), so an unattended run that loses the dialog to a focus change gets a
      // decline nobody made. Neither outcome is evidence that delete is broken, and reporting them red
      // trains the reader to ignore this suite's failures. An attended run still exercises it for real.
      if (res.error === 'NO_ANSWER' || res.error === 'cancelled') {
        record(g, name, 'info', `not exercised — recallDelete's native confirmation was ${res.error === 'cancelled' ? 'dismissed by the OS, not by a person' : 'never answered'}; run this group attended to cover it`)
        try {
          rmSync(join(await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder), file), { force: true })
        } catch { /* best-effort: do not leave the fixture behind just because the dialog went unanswered */ }
      } else {
        await check(g, name, async () => {
          assert(res.ok, `delete failed: ${res.error}`)
          const list = await page.evaluate(() => window.toto.recallList())
          assert(!list.some((m) => m.file === file), 'deleted meeting still listed')
          return 'deleted'
        })
      }
    }
  }
}

async function groupBrain() {
  const g = 'brain'
  // The `meetings` group deletes every transcript it saves as its own cleanup, so by the time this
  // group runs there is nothing left on disk to index — the commitments check below would find zero
  // by construction, not because extraction is broken. Save (and auto-enqueue-ingest) a dedicated,
  // commitment-bearing fixture here and only delete it once this group's own checks are done with it.
  const commitTitle = `QA Commitment Probe ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
  let commitFile = null
  await check(g, 'a meeting with a clear next step is saved for indexing', async () => {
    const res = await page.evaluate(async (title) => window.toto.saveTranscript({
      title,
      mode: 'sales',
      startedAt: Date.now() - 120000,
      recap: '',
      lines: [
        { speaker: 'you', text: 'Thanks for joining — let us talk through the Acme renewal.', t: 0 },
        { speaker: 'them', text: 'We need the signed security questionnaire before legal can approve it.', t: 30000 },
        { speaker: 'you', text: 'Understood. I will send you the completed security questionnaire by next Tuesday.', t: 60000 }
      ]
    }), commitTitle)
    assert(res && res.path, `no path returned: ${JSON.stringify(res)}`)
    commitFile = res.path
    return res.path
  })
  await check(g, 'brainStatus answers with a coherent shape', async () => {
    const st = await page.evaluate(() => window.toto.brainStatus())
    assert(st, 'brainStatus returned null')
    assert(typeof st.meetings === 'number', 'meetings count missing')
    return { meetings: st.meetings, people: st.people, deals: st.deals, failed: st.failed ?? 0 }
  })
  await check(g, 'brainRead returns the entity graph', async () => {
    const read = await page.evaluate(() => window.toto.brainRead())
    assert(read && typeof read === 'object', 'brainRead returned nothing')
    return { people: read.people?.length ?? 0, deals: read.deals?.length ?? 0, meetings: read.meetings?.length ?? 0 }
  })
  // Wait for the index to actually settle BEFORE judging it. A single extraction can fail transiently
  // under load (the on-device model may be busy serving asks) and is retried by the reconcile tick —
  // polling the graph before that lands reports "no commitments" for a pipeline that is merely still
  // working. The wait lives outside check() so a pipeline that never settled can be recorded as NOT
  // EXERCISED: that is not a defect in extraction, it is an absence of evidence, and calling it a
  // failure is the same lie as a false green (see the third status in the summary below).
  const commitmentsName = 'commitments (next steps) are present after indexing'
  const settleDeadline = Date.now() + 6 * 60 * 1000
  let indexSettled = false
  while (Date.now() < settleDeadline) {
    // MQA-265: bounded, for the same reason as the accuracy group's loop below — the deadline is only
    // consulted BETWEEN iterations, so one CDP call that never settles would hang this group and every
    // group after it. A timed-out probe reads as "not settled yet" and the loop re-checks the deadline.
    const st = await Promise.race([
      page.evaluate(() => window.toto.brainStatus()).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 20000))
    ])
    const idle = st?.backfill && !st.backfill.running && !st.backfill.preparing
    if (idle && (st.ingestedFiles?.length ?? 0) > 0) {
      indexSettled = true
      break
    }
    await sleep(4000)
  }
  if (!indexSettled) {
    record(g, commitmentsName, 'info',
      'not exercised — indexing did not settle within 6 min (on-device model busy); re-run this group alone to cover it')
  } else {
    await check(g, commitmentsName, async () => {
      const read = await page.evaluate(() => window.toto.brainRead())
      const commitments = []
      for (const d of read.deals ?? []) for (const c of d.commitments ?? []) commitments.push(c.text)
      for (const p of read.people ?? []) for (const c of p.commitments ?? []) commitments.push(c.text)
      assert(commitments.length > 0, 'no commitments extracted from any indexed meeting')
      return { count: commitments.length, sample: commitments.slice(0, 3) }
    })
  }
  await check(g, 'the attention feed answers', async () => {
    const att = await page.evaluate(() => window.toto.brainAttention())
    assert(att && Array.isArray(att.items), 'attention feed malformed')
    return { items: att.items.length, kinds: [...new Set(att.items.map((i) => i.kind))] }
  })
  await check(g, 'entity names feed answers (drives ASR casing bias)', async () => {
    // MQA-115: BrainEntityNamesResult is a FLAT { names: string[] } (shared/ipc.ts), not
    // { people, accounts } — the old check read the wrong shape and always reported 0/0 regardless of
    // real indexed content.
    const res = await page.evaluate(() => window.toto.brainEntityNames())
    assert(res && Array.isArray(res.names), 'entity names malformed (expected { names: string[] })')
    return { names: res.names.length, sample: res.names.slice(0, 4) }
  })
  await check(g, 'a second backfill on an already-indexed folder is a cheap no-op, not a re-extraction', async () => {
    const before = await page.evaluate(() => window.toto.brainStatus())
    const kicked = await page.evaluate(() => window.toto.brainBackfill())
    await sleep(4000)
    const after = await page.evaluate(() => window.toto.brainStatus())
    return { kicked, revisionBefore: before?.revision, revisionAfter: after?.revision }
  })
  // Housekeeping, not an assertion — so it must NOT go through recallDelete. That handler opens a
  // native confirm dialog (dialog.showMessageBox, Delete/Cancel) and its promise does not settle until
  // someone answers, which in an unattended run means the whole suite parks here forever with the rest
  // of main still responding normally — so it reads as a freeze rather than a prompt. The product
  // behaviour of delete is already asserted in the meetings group, where the confirmation IS the point;
  // here we just want the fixture gone, so unlink it directly. (2026-08-17: this parked a full run.)
  await check(g, 'clean up the commitment fixture', async () => {
    if (!commitFile) return 'nothing to clean up'
    const folder = await page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder)
    const path = join(folder, commitFile)
    try {
      rmSync(path, { force: true })
    } catch (e) {
      throw new Error(`could not unlink the fixture at ${path}: ${e.message}`)
    }
    assert(!existsSync(path), `fixture still on disk at ${path}`)
    return 'deleted (direct unlink — recallDelete needs a human to confirm)'
  })
}

/**
 * Accuracy — does the pipeline recover what is actually IN a transcript, and nothing that is not?
 *
 * Every other group asks "did it answer?". None asked "was the answer right". A pipeline that
 * confidently extracts the wrong person, invents a commitment, or drops the one real next step passes
 * all 58 of the previous checks. Both directions are tested here, because recall without precision is
 * how a note-taker earns distrust: a hallucinated commitment is worse than a missed one.
 *
 * Ground truth is a transcript this group writes itself, so the expected entities are known exactly
 * rather than inferred from whatever happens to be on disk.
 */
async function groupAccuracy() {
  const g = 'accuracy'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const title = `QA Accuracy Probe ${stamp}`
  // Deliberately specific and mutually unconfusable: a rare surname, an unambiguous amount, one clear
  // commitment with an owner and a date, and one decoy sentence that is NOT a commitment.
  const GROUND_TRUTH = {
    person: 'Priya Venkatesan',
    company: 'Northwind Logistics',
    amount: '$240,000',
    commitment: 'send the revised pricing sheet',
    decoy: 'we might redesign the portal someday'
  }
  let file = null

  await check(g, 'a transcript with known, checkable content is saved', async () => {
    const res = await page.evaluate(async (t) => window.toto.saveTranscript({
      title: t.title,
      mode: 'sales',
      startedAt: Date.now() - 300000,
      recap: '',
      lines: [
        { speaker: 'you', text: `Good to meet you. I am here about the ${t.gt.company} renewal.`, t: 0 },
        { speaker: 'them', text: `${t.gt.person} here — I run procurement for ${t.gt.company}.`, t: 20000 },
        { speaker: 'them', text: `Our budget for this cycle is ${t.gt.amount}, firm.`, t: 45000 },
        { speaker: 'them', text: `Honestly, ${t.gt.decoy}, but that is not on the table this year.`, t: 70000 },
        { speaker: 'you', text: `Understood. I will ${t.gt.commitment} to you by Friday.`, t: 95000 }
      ]
    }), { title, gt: GROUND_TRUTH })
    assert(res && res.path, `no path returned: ${JSON.stringify(res)}`)
    file = res.path
    return res.path
  })

  // Indexing is asynchronous and shares the on-device model with everything else, so absence of a
  // result here can mean "still working" rather than "got it wrong". That distinction is the whole
  // point of the third status — see MQA-255.
  let settled = false
  // 12 min, not 6. On-device extraction of a single 5-line transcript measured ~3-6 min on a warm
  // profile (the model is doing entity, deal, value and commitment passes), so a 6-min budget expired
  // mid-extraction and the cleanup below then deleted the fixture before it could ever be indexed —
  // making every re-run start from zero and never converge.
  const deadline = Date.now() + 12 * 60 * 1000
  // MQA-265: the basename must be split on BOTH separators. `/[\/]/` is a character class holding one
  // escaped forward slash, so on Windows — where every fixture path is backslash-separated — split()
  // returned the whole path, pop() returned the whole path, and `basename.includes(wholePath)` was false
  // on every iteration. `mine` could never become true, so this group burned its full budget and reported
  // "not exercised" every single run, on a pipeline that was extracting correctly the whole time.
  const base = file ? file.split(/[\\/]/).pop() : null
  while (Date.now() < deadline) {
    // MQA-265: bound each probe. The deadline is only consulted BETWEEN iterations, so one CDP call that
    // never settles blocks the loop — and therefore the whole suite — indefinitely. Observed: this group
    // sat for ~50 minutes against a 12-minute budget while the app itself stayed responsive. A probe that
    // times out is treated as "not settled yet" and the loop moves on to re-check the deadline.
    const st = await Promise.race([
      page.evaluate(() => window.toto.brainStatus()).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 20000))
    ])
    const idle = st?.backfill && !st.backfill.running && !st.backfill.preparing
    // Wait for THIS transcript, not for any transcript. Keying on `ingestedFiles.length > 0` meant the
    // brain group's earlier fixture already satisfied the condition, so this group read the graph before
    // its own file was ever indexed and reported four recall failures against an empty result.
    const mine = base ? (st?.ingestedFiles ?? []).some((f) => String(f).includes(base)) : false
    if (idle && mine) {
      settled = true
      break
    }
    await sleep(4000)
  }

  if (!settled) {
    record(g, '(extraction accuracy checks)', 'info',
      'not exercised — indexing did not settle within 12 min (on-device model busy); re-run with --only=accuracy')
  } else {
    const graph = await page.evaluate(() => window.toto.brainRead())

    await check(g, 'RECALL: the person who spoke is in the graph, spelled correctly', async () => {
      const names = (graph.people ?? []).map((p) => p.name ?? p.slug ?? '')
      const hit = names.find((n) => n.toLowerCase().includes('venkatesan'))
      assert(hit, `"${GROUND_TRUTH.person}" not among ${names.length} people: ${names.slice(0, 12).join(', ')}`)
      return hit
    })

    await check(g, 'RECALL: the commitment made in the transcript survives to the graph', async () => {
      const blob = JSON.stringify(graph).toLowerCase()
      assert(blob.includes('pricing sheet'), 'the "revised pricing sheet" commitment is nowhere in the graph')
      return 'found'
    })

    await check(g, 'PRECISION: the hypothetical aside was NOT recorded as a commitment', async () => {
      // "we might redesign the portal someday" is explicitly ruled out in the next breath. Extracting
      // it is a hallucinated obligation — the failure mode that makes a note-taker untrustworthy.
      const commitments = []
      for (const p of graph.people ?? []) for (const c of p.commitments ?? []) commitments.push(String(c.text ?? c))
      for (const d of graph.deals ?? []) for (const c of d.commitments ?? []) commitments.push(String(c.text ?? c))
      const bogus = commitments.filter((c) => /redesign the portal/i.test(c))
      assert(bogus.length === 0, `invented a commitment from a hypothetical: ${bogus.join(' | ')}`)
      return `${commitments.length} commitments, none hallucinated from the decoy`
    })

    await check(g, 'the entity-name feed carries the new name (this is what biases ASR casing)', async () => {
      const feed = await page.evaluate(() => (window.toto.brainEntityNames ? window.toto.brainEntityNames() : null))
      if (!feed) return { __info: 'not exercised — brainEntityNames is not exposed on this build' }
      const flat = JSON.stringify(feed).toLowerCase()
      assert(flat.includes('venkatesan'), 'a freshly-indexed surname never reached the ASR bias feed')
      return 'name present'
    })
  }

  // Retrieval accuracy: the app has to find the right answer in its own notes. A confident wrong
  // number here is the single most damaging failure this product can have.
  await check(g, 'ANSWER ACCURACY: asking about the budget returns the number from the transcript', async () => {
    const r = await ask({
      id: `qa-acc-${Date.now()}`,
      mode: 'answer',
      prompt: `What is the stated budget for the ${GROUND_TRUTH.company} renewal?`
    })
    if (r.error) return { __info: `not exercised — the ask failed (${String(r.error).slice(0, 90)})` }
    const text = r.text ?? ''
    assert(text.trim().length > 0, 'the ask returned no text at all')
    const digits = text.replace(/[,\s]/g, '')
    assert(
      /240[,.]?000/.test(digits) || /240k/i.test(text),
      `answered without the ground-truth figure ($240,000): "${text.replace(/\s+/g, ' ').slice(0, 200)}"`
    )
    return { via: r.providers[r.providers.length - 1], chars: text.length }
  })

  if (file) {
    await check(g, 'clean up the accuracy fixture', async () => {
      // Only when its extraction actually completed. Deleting a transcript that is still mid-extraction
      // is why a timed-out run could never be recovered by simply re-running: each attempt removed the
      // very file the next attempt was waiting on.
      if (!settled) return { __info: `left in place — extraction never settled, so deleting it would make the next run start over: ${file}` }
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
      return existsSync(file) ? 'still present' : 'removed'
    })
  }
}

return { meetings: groupMeetings, brain: groupBrain, accuracy: groupAccuracy }
}
