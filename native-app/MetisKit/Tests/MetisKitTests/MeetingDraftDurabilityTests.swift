import Foundation
import XCTest
@testable import MetisKit

final class MeetingDraftDurabilityTests: XCTestCase {
    @MainActor func testManualLineIsNotVisibleWithoutDurableDraftAcknowledgement() {
        let controller = MeetingController(intelligence: HeuristicIntelligence())
        let line = TranscriptLine(speaker: .me, text: "Synthetic manual line", at: Date(timeIntervalSince1970: 100))

        _ = controller.append(line)

        XCTAssertFalse(controller.meeting.lines.contains(line),
                       "A line must not be displayed before a durable draft acknowledges it")
    }

    @MainActor func testStreamLineIsNotVisibleWithoutDurableDraftAcknowledgement() async throws {
        let controller = MeetingController(intelligence: HeuristicIntelligence())
        let line = TranscriptLine(speaker: .them, text: "Synthetic speech line", at: Date(timeIntervalSince1970: 200))
        let stream = AsyncStream<TranscriptLine> { continuation in
            continuation.yield(line)
            continuation.finish()
        }

        controller.beginTranscription(stream)
        let draining = try XCTUnwrap(controller.transcriptionTask)
        await draining.value

        XCTAssertFalse(controller.meeting.lines.contains(line),
                       "A streamed line must not be displayed before a durable draft acknowledges it")
    }
}
