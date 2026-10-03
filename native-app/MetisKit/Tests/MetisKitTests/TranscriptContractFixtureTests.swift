import XCTest
@testable import MetisKit

final class TranscriptContractFixtureTests: XCTestCase {
    private struct Fixture {
        let name: String
        let data: Data
    }

    func testGoldenTranscriptFixturesDecode() throws {
        let fixtures = try loadFixtures(kind: "golden")
        XCTAssertEqual(fixtures.map(\.name), [
            "line.them-named.json",
            "line.unknown-language.json",
            "line.you.json"
        ])

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let lines = try fixtures.map { try decoder.decode(TranscriptLine.self, from: $0.data) }

        XCTAssertEqual(lines.map(\.speaker), [.them, .unknown, .me])
        XCTAssertEqual(lines[0].name, "Speaker 1")
        XCTAssertEqual(lines[2].id.uuidString, "22222222-2222-4222-8222-222222222222")
    }

    func testNegativeTranscriptFixturesReject() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for fixture in try loadFixtures(kind: "negative") {
            XCTAssertThrowsError(try decoder.decode(TranscriptLine.self, from: fixture.data), fixture.name)
        }
    }

    func testTranscriptSpeakerEncodesMeForPersistedData() throws {
        let line = TranscriptLine(
            id: UUID(uuidString: "77777777-7777-4777-8777-777777777777")!,
            speaker: .me,
            text: "Persisted speaker value stays native.",
            at: Date(timeIntervalSince1970: 1_700_000_040)
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(line)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["speaker"] as? String, "me")
    }

    private func loadFixtures(kind: String) throws -> [Fixture] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/contracts/transcript")
            .appendingPathComponent(kind)
        let urls = try FileManager.default
            .contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        return try urls.map { Fixture(name: $0.lastPathComponent, data: try Data(contentsOf: $0)) }
    }
}
