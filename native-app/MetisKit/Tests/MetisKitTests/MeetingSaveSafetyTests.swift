import Foundation
import Dispatch
import XCTest
@testable import MetisKit

private enum SyntheticFailure: Error { case injected, gateDeadline, gateReleased }

private actor SaveSafetyGate {
    private var entered = false
    private var released = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var observer: CheckedContinuation<Void, any Error>?
    private var watchdog: DispatchWorkItem?

    func wait() async {
        entered = true
        watchdog?.cancel()
        watchdog = nil
        observer?.resume()
        observer = nil
        if released { return }
        await withCheckedContinuation { waiter = $0 }
    }

    func waitUntilEntered() async throws {
        if entered { return }
        if released { throw SyntheticFailure.gateReleased }
        try await withCheckedThrowingContinuation { observer = $0
            // Failure bound only. Successful ordering is established by wait()'s continuation signal.
            let deadline = DispatchWorkItem { Task { await self.observationExpired() } }
            watchdog = deadline
            DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: deadline)
        }
    }

    private func observationExpired() {
        watchdog?.cancel()
        watchdog = nil
        observer?.resume(throwing: SyntheticFailure.gateDeadline)
        observer = nil
    }

    func release() {
        released = true
        watchdog?.cancel()
        watchdog = nil
        observer?.resume(throwing: SyntheticFailure.gateReleased)
        observer = nil
        waiter?.resume()
        waiter = nil
    }
}

private actor StopProbe {
    private(set) var calls = 0
    var fails = false
    let gate: SaveSafetyGate?

    init(gate: SaveSafetyGate? = nil) { self.gate = gate }
    func setFailure(_ value: Bool) { fails = value }
    func stop() async throws {
        calls += 1
        if let gate { await gate.wait() }
        if fails { throw SyntheticFailure.injected }
    }
}

private struct SaveSafetyIntelligence: MeetingIntelligence {
    let gate: SaveSafetyGate?
    let fails: Bool
    let summary = MeetingSummaryText(headline: "Synthetic outcome", decisions: [], actionItems: [], openQuestions: [])
    var availability: IntelligenceAvailability { .available }

    init(gate: SaveSafetyGate? = nil, fails: Bool = false) {
        self.gate = gate
        self.fails = fails
    }

    func suggestStream(transcriptTail: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func suggest(transcriptTail: String) async throws -> String {
        if let gate { await gate.wait() }
        if fails { throw SyntheticFailure.injected }
        return "Synthetic suggestion"
    }
    func summarize(transcriptTail: String) async throws -> MeetingSummaryText {
        if let gate { await gate.wait() }
        if fails { throw SyntheticFailure.injected }
        return summary
    }
    func nextSteps(transcriptTail: String) async throws -> [String] { ["Synthetic next step"] }
}

private actor TwoSuggestionIntelligence: MeetingIntelligence {
    nonisolated let availability: IntelligenceAvailability = .available
    private let older: SaveSafetyGate
    private let newer: SaveSafetyGate
    private var calls = 0

    init(older: SaveSafetyGate, newer: SaveSafetyGate) {
        self.older = older
        self.newer = newer
    }

    nonisolated func suggestStream(transcriptTail: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func suggest(transcriptTail: String) async throws -> String {
        calls += 1
        let call = calls
        await (call == 1 ? older : newer).wait()
        return call == 1 ? "Older suggestion" : "Newer suggestion"
    }
    func summarize(transcriptTail: String) async throws -> MeetingSummaryText {
        MeetingSummaryText(headline: "Synthetic outcome", decisions: [], actionItems: [], openQuestions: [])
    }
    func nextSteps(transcriptTail: String) async throws -> [String] { [] }
}

final class MeetingSaveSafetyTests: XCTestCase {
    @MainActor private func controller(intelligence: MeetingIntelligence = SaveSafetyIntelligence()) -> MeetingController {
        MeetingController(intelligence: intelligence, meeting: Meeting(title: "Synthetic meeting", startedAt: Date(timeIntervalSince1970: 100)))
    }

    private func line(_ text: String = "Synthetic transcript") -> TranscriptLine {
        TranscriptLine(speaker: .me, text: text, at: Date(timeIntervalSince1970: 101))
    }

    @MainActor private func expectError(
        _ expected: MeetingOperationError,
        _ operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("Expected a fixed operation error", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? MeetingOperationError, expected, file: file, line: line)
        }
    }

    @MainActor private func whileHeld<Value: Sendable>(
        _ task: Task<Value, any Error>,
        by gate: SaveSafetyGate,
        check: @MainActor () async throws -> Void
    ) async throws -> Result<Value, any Error> {
        do {
            try await gate.waitUntilEntered()
            try await check()
        } catch {
            await gate.release()
            _ = await task.result
            throw error // Keep the observation/check failure, not a secondary cleanup result.
        }
        await gate.release()
        return await task.result
    }

    @MainActor func testSuccessfulStopSavesExactSnapshotBeforeOneReset() async throws {
        let c = controller()
        let audio = StopProbe()
        c.audioStop = { try await audio.stop() }
        let originalID = c.meeting.id
        let transcript = line()
        c.append(transcript)
        let summary = try await c.summaryText()
        var saves = 0
        c.bindPersistence { meeting, savedSummary in
            saves += 1
            let stops = await audio.calls
            XCTAssertEqual(stops, 1)
            XCTAssertFalse(c.isRecording)
            XCTAssertTrue(c.isTransitioning)
            XCTAssertEqual(c.meeting.id, originalID)
            XCTAssertEqual(meeting.id, originalID)
            XCTAssertEqual(meeting.lines, [transcript])
            XCTAssertNotNil(meeting.endedAt)
            XCTAssertEqual(savedSummary, summary)
        }
        try await c.startRecording()
        try await c.stopRecording()
        XCTAssertEqual(saves, 1)
        XCTAssertNotEqual(c.meeting.id, originalID)
        XCTAssertTrue(c.meeting.lines.isEmpty)
        XCTAssertFalse(c.needsSaveRetry)
        XCTAssertNil(c.operationError)
        let nextID = c.meeting.id
        try await c.stopRecording()
        XCTAssertEqual(c.meeting.id, nextID)
        XCTAssertEqual(saves, 1)
    }

    @MainActor func testEmptyStopThenManualAppendThenStartPreservesNewText() async throws {
        let c = controller()
        var saves = 0
        c.bindPersistence { _, _ in saves += 1 }
        try await c.startRecording()
        let endedID = c.meeting.id
        try await c.stopRecording()
        XCTAssertNotNil(c.meeting.endedAt)
        try await c.stopRecording()
        XCTAssertEqual(c.meeting.id, endedID)
        let added = line("New manual draft")
        XCTAssertTrue(c.append(added))
        let draftID = c.meeting.id
        XCTAssertNotEqual(draftID, endedID)
        XCTAssertNil(c.meeting.endedAt)
        try await c.startRecording()
        XCTAssertEqual(c.meeting.id, draftID)
        XCTAssertEqual(c.meeting.lines, [added])
        XCTAssertEqual(saves, 0)
    }

    @MainActor func testAudioStopFailureRetainsDataAndRetriesStop() async throws {
        let c = controller()
        let audio = StopProbe()
        await audio.setFailure(true)
        c.audioStop = { try await audio.stop() }
        let transcript = line()
        c.append(transcript)
        let summary = try await c.summaryText()
        let id = c.meeting.id
        var saves = 0
        c.bindPersistence { meeting, savedSummary in
            saves += 1
            XCTAssertEqual(meeting.lines, [transcript])
            XCTAssertEqual(savedSummary, summary)
        }
        try await c.startRecording()
        await expectError(.stopFailed) { try await c.stopRecording() }
        XCTAssertTrue(c.isRecording)
        XCTAssertEqual(c.meeting.id, id)
        XCTAssertEqual(c.meeting.lines, [transcript])
        XCTAssertNil(c.meeting.endedAt)
        XCTAssertFalse(c.reset())
        XCTAssertEqual(saves, 0)
        XCTAssertEqual(c.operationError, .stopFailed)
        await audio.setFailure(false)
        try await c.stopRecording()
        XCTAssertEqual(saves, 1)
        let calls = await audio.calls
        XCTAssertEqual(calls, 2)
    }

    @MainActor func testSaveFailureKeepsSnapshotAndRetryDoesNotStopAudioAgain() async throws {
        let c = controller()
        let actions: any MeetingActions = c
        let audio = StopProbe()
        c.audioStop = { try await audio.stop() }
        c.append(line())
        var attempts: [Meeting] = []
        c.bindPersistence { meeting, summary in
            attempts.append(meeting)
            XCTAssertNil(summary)
            if attempts.count == 1 { throw SyntheticFailure.injected }
        }
        try await actions.startRecording()
        await expectError(.saveFailed) { try await actions.stopRecording() }
        XCTAssertFalse(c.isRecording)
        XCTAssertTrue(c.needsSaveRetry)
        XCTAssertEqual(c.operationError, .saveFailed)
        let pending = c.meeting
        XCTAssertFalse(c.reset())
        XCTAssertFalse(c.append(line("Must not replace pending data")))
        await expectError(.savePending) { try await actions.startRecording() }
        XCTAssertEqual(c.meeting.id, pending.id)
        XCTAssertEqual(c.meeting.lines, pending.lines)
        try await actions.stopRecording()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0].id, attempts[1].id)
        XCTAssertEqual(attempts[0].endedAt, attempts[1].endedAt)
        XCTAssertEqual(attempts[0].lines, attempts[1].lines)
        let calls = await audio.calls
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(c.meeting.lines.isEmpty)
    }

    @MainActor func testMissingBindingFailsClosedAndLaterBindingCanRetry() async throws {
        let c = controller()
        c.append(line())
        try await c.startRecording()
        await expectError(.saveUnavailable) { try await c.stopRecording() }
        XCTAssertTrue(c.needsSaveRetry)
        XCTAssertEqual(c.meeting.lines.count, 1)
        var saves = 0
        c.bindPersistence { _, _ in saves += 1 }
        c.bindPersistence { _, _ in XCTFail("Existing binding must not be replaced") }
        try await c.stopRecording()
        XCTAssertEqual(saves, 1)
        XCTAssertTrue(c.meeting.lines.isEmpty)
    }

    @MainActor func testIdleManualDraftStopPersistsAndRetriesWithoutStoppingAudio() async throws {
        let c = controller()
        let actions: any MeetingActions = c
        let audio = StopProbe()
        c.audioStop = { try await audio.stop() }
        let transcript = line()
        c.append(transcript)
        let id = c.meeting.id
        var attempts = 0
        c.bindPersistence { meeting, _ in
            attempts += 1
            XCTAssertEqual(meeting.id, id)
            XCTAssertEqual(meeting.lines, [transcript])
            if attempts == 1 { throw SyntheticFailure.injected }
        }
        await expectError(.saveFailed) { try await actions.stopRecording() }
        XCTAssertEqual(c.meeting.id, id)
        XCTAssertEqual(c.meeting.lines, [transcript])
        XCTAssertTrue(c.needsSaveRetry)
        try await actions.stopRecording()
        let calls = await audio.calls
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(attempts, 2)
        XCTAssertTrue(c.meeting.lines.isEmpty)
        let nextID = c.meeting.id
        try await actions.stopRecording()
        XCTAssertEqual(c.meeting.id, nextID)
        XCTAssertEqual(attempts, 2)
    }

    @MainActor func testConcurrentStartAndStopDuringStartAreRejected() async throws {
        let c = controller()
        let gate = SaveSafetyGate()
        c.audioStart = { await gate.wait() }
        let starting = Task { try await c.startRecording() }
        let result = try await whileHeld(starting, by: gate) {
            await self.expectError(.operationInProgress) { try await c.startRecording() }
            await self.expectError(.operationInProgress) { try await c.stopRecording() }
        }
        try result.get()
        XCTAssertTrue(c.isRecording)
        XCTAssertFalse(c.isTransitioning)
    }

    @MainActor func testConcurrentTransitionsAreRejectedDuringAudioStop() async throws {
        let c = controller()
        let gate = SaveSafetyGate()
        let audio = StopProbe(gate: gate)
        c.audioStop = { try await audio.stop() }
        c.append(line())
        var saves = 0
        c.bindPersistence { _, _ in saves += 1 }
        try await c.startRecording()
        let stopping = Task { try await c.stopRecording() }
        let result = try await whileHeld(stopping, by: gate) {
            await self.expectError(.operationInProgress) { try await c.stopRecording() }
            await self.expectError(.operationInProgress) { try await c.startRecording() }
            XCTAssertFalse(c.reset())
            XCTAssertFalse(c.append(self.line("Blocked manual write")))
        }
        try result.get()
        let calls = await audio.calls
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(saves, 1)
    }

    @MainActor func testConcurrentTransitionsAreRejectedDuringSave() async throws {
        let c = controller()
        let gate = SaveSafetyGate()
        c.append(line())
        var saves = 0
        c.bindPersistence { _, _ in
            saves += 1
            await gate.wait()
        }
        try await c.startRecording()
        let stopping = Task { try await c.stopRecording() }
        let result = try await whileHeld(stopping, by: gate) {
            XCTAssertFalse(c.isRecording)
            await self.expectError(.operationInProgress) { try await c.stopRecording() }
            await self.expectError(.operationInProgress) { try await c.startRecording() }
            XCTAssertFalse(c.reset())
        }
        try result.get()
        XCTAssertEqual(saves, 1)
    }

    @MainActor func testLateSummaryCannotAlterPendingSnapshot() async throws {
        let gate = SaveSafetyGate()
        let c = controller(intelligence: SaveSafetyIntelligence(gate: gate))
        c.append(line())
        c.bindPersistence { _, summary in
            XCTAssertNil(summary)
            throw SyntheticFailure.injected
        }
        try await c.startRecording()
        let revision = c.actionRevision
        let summarizing = Task { try await c.summaryText() }
        let result = try await whileHeld(summarizing, by: gate) {
            await self.expectError(.saveFailed) { try await c.stopRecording() }
        }
        await expectError(.staleAction) { _ = try result.get() }
        XCTAssertFalse(c.acceptsAction(revision))
        XCTAssertEqual(c.meeting.lines.count, 1)
    }

    @MainActor func testLateFailureFromPriorSessionCannotBecomeNewSessionError() async throws {
        let gate = SaveSafetyGate()
        let c = controller(intelligence: SaveSafetyIntelligence(gate: gate, fails: true))
        c.append(line())
        c.bindPersistence { _, _ in }
        try await c.startRecording()
        let oldRevision = c.actionRevision
        let suggesting = Task { try await c.suggestion() }
        let result = try await whileHeld(suggesting, by: gate) {
            try await c.stopRecording()
            XCTAssertTrue(c.acceptsAction(c.actionRevision))
        }
        let newRevision = c.actionRevision
        await expectError(.staleAction) { _ = try result.get() }
        XCTAssertFalse(c.acceptsAction(oldRevision))
        XCTAssertTrue(c.acceptsAction(newRevision))
        XCTAssertNil(c.operationError)
    }

    @MainActor func testLateSummaryCannotPopulateNewSessionAfterSuccessfulStop() async throws {
        let gate = SaveSafetyGate()
        let c = controller(intelligence: SaveSafetyIntelligence(gate: gate))
        c.append(line())
        let oldID = c.meeting.id
        var summaries: [MeetingSummaryText?] = []
        c.bindPersistence { _, summary in summaries.append(summary) }
        try await c.startRecording()
        let summarizing = Task { try await c.summaryText() }
        let result = try await whileHeld(summarizing, by: gate) {
            try await c.stopRecording()
            XCTAssertNotEqual(c.meeting.id, oldID)
        }
        await expectError(.staleAction) { _ = try result.get() }
        c.append(line("Next meeting"))
        try await c.stopRecording()
        XCTAssertEqual(summaries.count, 2)
        XCTAssertNil(summaries[0])
        XCTAssertNil(summaries[1])
    }

    @MainActor func testLateTranscriptionStreamCannotChangeNextMeeting() async throws {
        let c = controller()
        let original = line("Original meeting")
        let next = line("Next meeting")
        let late = line("Late prior-session callback")
        c.append(original)
        var saved: [Meeting] = []
        c.bindPersistence { meeting, _ in saved.append(meeting) }
        try await c.startRecording()

        let gate = SaveSafetyGate()
        let cancelled = SaveSafetyGate()
        let stream = AsyncStream<TranscriptLine>(
            unfolding: {
                await gate.wait() // The old consumer has requested its next line.
                return late
            },
            onCancel: { _ = Task { await cancelled.wait() } }
        )
        c.beginTranscription(stream)
        let draining = try XCTUnwrap(c.transcriptionTask)
        do {
            try await gate.waitUntilEntered()
            try await c.stopRecording()
            try await cancelled.waitUntilEntered()
        } catch {
            await gate.release()
            await cancelled.release()
            throw error
        }
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(try XCTUnwrap(saved.first).lines, [original])
        let nextID = c.meeting.id
        XCTAssertTrue(c.append(next))
        await gate.release()
        await draining.value
        await cancelled.release()
        XCTAssertEqual(c.meeting.id, nextID)
        XCTAssertEqual(c.meeting.lines, [next])
        XCTAssertEqual(try XCTUnwrap(saved.first).lines, [original])
    }

    @MainActor func testOlderActionCompletionCannotDisturbWorkingNewerAction() async throws {
        let olderGate = SaveSafetyGate()
        let newerGate = SaveSafetyGate()
        let c = controller(intelligence: TwoSuggestionIntelligence(older: olderGate, newer: newerGate))
        c.append(line("Original meeting"))
        c.bindPersistence { _, _ in }
        let older = Task { try await c.suggestion() }
        let olderResult = try await whileHeld(older, by: olderGate) {
            try await c.stopRecording()
            let next = self.line("Next meeting")
            XCTAssertTrue(c.append(next))
            let nextID = c.meeting.id
            let nextRevision = c.actionRevision
            let newer = Task { try await c.suggestion() }
            let newerResult = try await self.whileHeld(newer, by: newerGate) {
                await olderGate.release()
                await self.expectError(.staleAction) { _ = try await older.value }
                XCTAssertEqual(c.meeting.id, nextID)
                XCTAssertEqual(c.meeting.lines, [next])
                XCTAssertTrue(c.acceptsAction(nextRevision))
                XCTAssertNil(c.operationError)
            }
            let text = try newerResult.get()
            XCTAssertEqual(text, "Newer suggestion")
        }
        await expectError(.staleAction) { _ = try olderResult.get() }
    }

    @MainActor func testStartFailureIsVisibleWithoutDroppingManualLines() async throws {
        let c = controller()
        let transcript = line()
        c.append(transcript)
        c.audioStart = { throw SyntheticFailure.injected }
        await expectError(.startFailed) { try await c.startRecording() }
        XCTAssertFalse(c.isRecording)
        XCTAssertFalse(c.isTransitioning)
        XCTAssertEqual(c.meeting.lines, [transcript])
        XCTAssertEqual(c.operationError, .startFailed)
    }

    func testOperationErrorsHaveFixedUsefulMessages() {
        XCTAssertEqual(MeetingOperationError.saveFailed.errorDescription,
                       "Your transcript is retained. Saving failed; choose Retry save.")
        XCTAssertEqual(MeetingOperationError.stopFailed.errorDescription,
                       "Your transcript is retained. Capture could not be stopped; try Stop again.")
    }
}
