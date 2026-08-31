import XCTest
@testable import MetisKit

/// The native app's SwiftData history stores each meeting's transcript as a JSON blob of `[TranscriptLine]`
/// (App/Store/PersistedModels.swift) rather than a second SwiftData schema, so this Codable contract IS the
/// persistence contract. If it ever breaks, saved meetings decode empty — hence a direct round-trip test.
/// (The SwiftData container integration itself is exercised on-device via native-app/docs/QA-CHECKLIST.md,
/// since it needs an app host Xcode provides, not `swift test`.)
final class PersistenceCodableTests: XCTestCase {
    func testTranscriptLinesSurviveJSONRoundTrip() throws {
        let lines = [
            TranscriptLine(speaker: .them, name: "Jane", text: "Can you send the deck by Friday?", at: Date(timeIntervalSince1970: 1_700_000_000)),
            TranscriptLine(speaker: .me, text: "Yes — Friday works.", at: Date(timeIntervalSince1970: 1_700_000_030)),
            TranscriptLine(speaker: .unknown, text: "(crosstalk)", at: Date(timeIntervalSince1970: 1_700_000_060))
        ]
        let data = try JSONEncoder().encode(lines)
        let decoded = try JSONDecoder().decode([TranscriptLine].self, from: data)

        XCTAssertEqual(decoded.count, 3)
        XCTAssertEqual(decoded[0].speaker, .them)
        XCTAssertEqual(decoded[0].name, "Jane")
        XCTAssertEqual(decoded[0].text, "Can you send the deck by Friday?")
        XCTAssertNil(decoded[1].name, "an omitted name must decode back to nil, not empty string")
        XCTAssertEqual(decoded[2].speaker, .unknown)
        XCTAssertEqual(decoded, lines, "round-trip must be lossless (TranscriptLine is Equatable)")
    }

    func testEmptyTranscriptRoundTrips() throws {
        let data = try JSONEncoder().encode([TranscriptLine]())
        XCTAssertEqual(try JSONDecoder().decode([TranscriptLine].self, from: data), [])
    }
}
