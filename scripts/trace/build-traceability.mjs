#!/usr/bin/env node
/**
 * build-traceability.mjs — RED-phase stub for M2-0011.
 *
 * Every export below throws (or, for the two regex constants, never matches) on purpose:
 * this commit adds only the module surface the tests in build-traceability.test.ts need to
 * resolve against, with zero real logic. Each export carries an explicit JSDoc `@type` so
 * `npx tsc --noEmit -p tsconfig.tests.json` sees a plain `any`-shaped API instead of inferring
 * `never` from the unconditional throw — that keeps the test file's own type-checking honest
 * (it is checked against the real signatures, not against this stub) while the stub itself
 * stays inert. The real implementation lands in the next commit once CI has recorded this RED
 * run for the reasons the ticket describes.
 */

/** @type {RegExp} Never matches; replaced by the real M2-[A-Z]+-\d{2} pattern in the GREEN commit. */
export const KIT_REQUIREMENT_ID_RE = /$^/

/** @type {RegExp} Never matches; replaced by the real M2-\d{4} pattern in the GREEN commit. */
export const PROGRAM_TICKET_ID_RE = /$^/

/** @param {string} name @returns {(...args: any[]) => any} */
function notImplemented(name) {
  return (..._args) => {
    throw new Error(`${name}() is not implemented yet — see ticket M2-0011`)
  }
}

/** @type {(...args: any[]) => any} */
export const classifyM2Id = notImplemented('classifyM2Id')
/** @type {(...args: any[]) => any} */
export const buildInventoryIndex = notImplemented('buildInventoryIndex')
/** @type {(...args: any[]) => any} */
export const resolveCitation = notImplemented('resolveCitation')
/** @type {(...args: any[]) => any} */
export const statusForTicket = notImplemented('statusForTicket')
/** @type {(...args: any[]) => any} */
export const mergeStatuses = notImplemented('mergeStatuses')
/** @type {(...args: any[]) => any} */
export const computeRowStatus = notImplemented('computeRowStatus')
/** @type {(...args: any[]) => any} */
export const extractDecisionIds = notImplemented('extractDecisionIds')
/** @type {(...args: any[]) => any} */
export const extractBlockerTicketRefs = notImplemented('extractBlockerTicketRefs')
/** @type {(...args: any[]) => any} */
export const buildTraceability = notImplemented('buildTraceability')
/** @type {(...args: any[]) => any} */
export const renderMarkdown = notImplemented('renderMarkdown')
/** @type {(...args: any[]) => any} */
export const renderJson = notImplemented('renderJson')
/** @type {(...args: any[]) => any} */
export const main = notImplemented('main')
