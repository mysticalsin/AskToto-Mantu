import XCTest
@testable import MetisKit

final class MetisKitTests: XCTestCase {
    func testTranscriptTailBoundsAndLabels() {
        var m = Meeting(title: "Q3 review", startedAt: Date())
        m.lines = [
            TranscriptLine(speaker: .them, name: "Jane", text: "Can you send the DPO note?", at: Date()),
            TranscriptLine(speaker: .me, text: "Yes, by Friday.", at: Date()),
            TranscriptLine(speaker: .them, text: "And the Mac rollout timeline?", at: Date())
        ]
        let tail = m.transcriptTail(maxChars: 6000)
        XCTAssertTrue(tail.contains("Jane: Can you send"))
        XCTAssertTrue(tail.contains("You: Yes, by Friday"))
        XCTAssertTrue(tail.contains("Them: And the Mac rollout"))
    }

    func testTranscriptTailTruncatesToLastChars() {
        var m = Meeting(title: "long", startedAt: Date())
        m.lines = (0..<500).map { TranscriptLine(speaker: .them, text: "line number \($0) with some content", at: Date()) }
        XCTAssertLessThanOrEqual(m.transcriptTail(maxChars: 1000).count, 1000)
    }

    func testHeuristicIntelligenceNeverThrowsAndIsUnavailable() async throws {
        let intel = HeuristicIntelligence()
        if case .available = intel.availability { XCTFail("heuristic must report unavailable") }
        let s = try await intel.suggest(transcriptTail: "Them: what's the status?")
        XCTAssertFalse(s.isEmpty)
        let empty = try await intel.suggest(transcriptTail: "")
        XCTAssertFalse(empty.isEmpty)
        let sum = try await intel.summarize(transcriptTail: "Them: hi")
        XCTAssertFalse(sum.headline.isEmpty)
    }

    func testHeuristicStreamYieldsOneshot() async throws {
        var out = ""
        for try await chunk in HeuristicIntelligence().suggestStream(transcriptTail: "Them: hello") { out += chunk }
        XCTAssertFalse(out.isEmpty)
    }

    func testMakeMeetingIntelligenceResolves() {
        // On CI/simulator without the model this returns the heuristic; on an Apple-Intelligence device
        // it returns the Foundation Model impl. Either way it must resolve to a working instance.
        let intel = makeMeetingIntelligence()
        _ = intel.availability // must not crash
    }

    func testHeuristicNextSteps() async throws {
        let intel = HeuristicIntelligence()
        let empty = try await intel.nextSteps(transcriptTail: "")
        XCTAssertTrue(empty.isEmpty, "no transcript → no invented next steps")
        let steps = try await intel.nextSteps(transcriptTail: "Them: can you send the deck by Friday?")
        XCTAssertFalse(steps.isEmpty)
    }

    @MainActor
    func testMeetingControllerRecordingTogglesIdempotently() async throws {
        let c = MeetingController(intelligence: HeuristicIntelligence())
        XCTAssertFalse(c.isRecording)
        try await c.startRecording()
        XCTAssertTrue(c.isRecording)
        try await c.startRecording() // a second Siri "start" must not restart
        XCTAssertTrue(c.isRecording)
        try await c.stopRecording()
        XCTAssertFalse(c.isRecording)
        XCTAssertNotNil(c.meeting.endedAt)
    }

    @MainActor
    func testMeetingControllerLastSaidAndNextSteps() async throws {
        let c = MeetingController(intelligence: HeuristicIntelligence())
        c.append(TranscriptLine(speaker: .me, text: "Hi", at: Date()))
        c.append(TranscriptLine(speaker: .them, name: "Jane", text: "Send the deck by Friday.", at: Date()))
        c.append(TranscriptLine(speaker: .me, text: "Will do", at: Date()))
        let last = try await c.lastThingSaid()
        XCTAssertEqual(last, "Send the deck by Friday.") // the last THEM line, not the last line overall
        let steps = try await c.nextSteps()
        XCTAssertFalse(steps.isEmpty)
        XCTAssertFalse(c.intelligenceAvailable) // heuristic → not the on-device model
    }

    @MainActor
    func testBeginTranscriptionAppendsStreamedLines() async throws {
        let c = MeetingController(intelligence: HeuristicIntelligence())
        let stream = AsyncStream<TranscriptLine> { cont in
            cont.yield(TranscriptLine(speaker: .them, text: "Hello", at: Date()))
            cont.yield(TranscriptLine(speaker: .me, text: "Hi there", at: Date()))
            cont.finish()
        }
        c.beginTranscription(stream)
        // Let the draining task run (the stream is already fully buffered + finished).
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(c.meeting.lines.count, 2)
        XCTAssertEqual(c.meeting.lines.first?.text, "Hello")
        c.endTranscription() // idempotent, must not crash
    }
}
