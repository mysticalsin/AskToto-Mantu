import Foundation
import SwiftData
import XCTest
import MetisKit

private enum PersistenceTestError: Error { case injected, unsafeHome }

final class MeetingPersistenceTests: XCTestCase {
    /// Every store/fixture factory calls this before creating anything, not only in a standalone test.
    private func ownedRoot() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        guard environment["CI"] == "true", environment["GITHUB_ACTIONS"] == "true",
              let expected = environment["METIS_TEST_HOME"],
              let runner = environment["RUNNER_TEMP"],
              expected == NSHomeDirectory(),
              expected == FileManager.default.homeDirectoryForCurrentUser.path,
              expected == environment["HOME"], expected == environment["CFFIXED_USER_HOME"]
        else { throw PersistenceTestError.unsafeHome }
        let root = URL(fileURLWithPath: expected, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        let runnerRoot = URL(fileURLWithPath: runner, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        guard root.path.hasPrefix(runnerRoot.path + "/"),
              root.lastPathComponent.hasPrefix("metis-persistence-home-"),
              root.path == URL(fileURLWithPath: expected).standardizedFileURL.path
        else { throw PersistenceTestError.unsafeHome }
        return root
    }

    @MainActor private func container(diskURL: URL? = nil) throws -> ModelContainer {
        let root = try ownedRoot()
        let configuration: ModelConfiguration
        if let diskURL {
            guard diskURL.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(root.path + "/")
            else { throw PersistenceTestError.unsafeHome }
            configuration = ModelConfiguration(url: diskURL, cloudKitDatabase: .none)
        } else {
            configuration = ModelConfiguration(UUID().uuidString, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        }
        return try ModelContainer(for: StoredMeeting.self, configurations: configuration)
    }

    private func diskFixture() throws -> URL {
        let root = try ownedRoot()
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        return directory.appendingPathComponent("synthetic.store")
    }

    private func meeting() -> Meeting {
        Meeting(title: "Synthetic meeting", startedAt: Date(timeIntervalSince1970: 100),
                endedAt: Date(timeIntervalSince1970: 200), lines: [
                    TranscriptLine(speaker: .me, text: "Synthetic first line", at: Date(timeIntervalSince1970: 101)),
                    TranscriptLine(speaker: .them, name: "Synthetic speaker", text: "Synthetic response", at: Date(timeIntervalSince1970: 102))
                ])
    }

    @MainActor private func rows(_ container: ModelContainer) throws -> [StoredMeeting] {
        try ModelContext(container).fetch(FetchDescriptor<StoredMeeting>())
    }

    @MainActor func testExactPayloadAndRepeatSaveUpsert() throws {
        let store = try container()
        let meeting = meeting()
        let summary = MeetingSummaryText(headline: "Synthetic outcome", decisions: [], actionItems: [], openQuestions: [])
        try MeetingStore.save(meeting, summary: summary, into: store)
        try MeetingStore.save(meeting, summary: summary, into: store)
        let saved = try rows(store)
        XCTAssertEqual(saved.count, 1)
        let row = try XCTUnwrap(saved.first)
        XCTAssertEqual(row.meetingID, meeting.id)
        XCTAssertEqual(row.title, meeting.title)
        XCTAssertEqual(row.startedAt, meeting.startedAt)
        XCTAssertEqual(row.endedAt, meeting.endedAt)
        XCTAssertEqual(row.lineCount, meeting.lines.count)
        XCTAssertEqual(row.lines, meeting.lines)
        XCTAssertEqual(row.summaryHeadline, summary.headline)
    }

    @MainActor func testPreCommitFailureRollsBackAndRetryCreatesOneRow() throws {
        let store = try container()
        let meeting = meeting()
        XCTAssertThrowsError(try MeetingStore.save(meeting, summary: nil, into: store) { _ in
            throw PersistenceTestError.injected
        })
        XCTAssertTrue(try rows(store).isEmpty)
        try MeetingStore.save(meeting, summary: nil, into: store)
        XCTAssertEqual(try rows(store).count, 1)
    }

    @MainActor func testCommitThenErrorRetryUsesOriginalUUID() throws {
        let store = try container()
        let meeting = meeting()
        XCTAssertThrowsError(try MeetingStore.save(meeting, summary: nil, into: store) { context in
            try context.save()
            throw PersistenceTestError.injected
        })
        XCTAssertEqual(try rows(store).count, 1)
        try MeetingStore.save(meeting, summary: nil, into: store)
        let saved = try rows(store)
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved.first?.meetingID, meeting.id)
        XCTAssertEqual(saved.first?.lines, meeting.lines)
    }

    @MainActor func testFailedUpdateRetainsCommittedPayload() throws {
        let store = try container()
        var meeting = meeting()
        try MeetingStore.save(meeting, summary: nil, into: store)
        let originalLines = meeting.lines
        meeting.title = "Replacement"
        meeting.lines.removeLast()
        XCTAssertThrowsError(try MeetingStore.save(meeting, summary: nil, into: store) { _ in
            throw PersistenceTestError.injected
        })
        let saved = try XCTUnwrap(rows(store).first)
        XCTAssertEqual(saved.title, "Synthetic meeting")
        XCTAssertEqual(saved.lines, originalLines)
    }

    @MainActor func testAttemptRollbackPreservesOtherContextsUnsavedInsertAndUpdate() throws {
        let store = try container()
        let existing = meeting()
        try MeetingStore.save(existing, summary: nil, into: store)
        let other = ModelContext(store)
        other.autosaveEnabled = false
        let edited = try XCTUnwrap(other.fetch(FetchDescriptor<StoredMeeting>()).first)
        edited.title = "Unsaved edit"
        let insertedID = UUID()
        let inserted = StoredMeeting(meetingID: insertedID, title: "Unsaved insert", startedAt: existing.startedAt,
                                     endedAt: nil, lineCount: 0, summaryHeadline: nil, linesData: Data("[]".utf8))
        other.insert(inserted)
        XCTAssertTrue(other.hasChanges)
        XCTAssertThrowsError(try MeetingStore.save(meeting(), summary: nil, into: store) { _ in
            throw PersistenceTestError.injected
        })
        XCTAssertTrue(other.hasChanges)
        XCTAssertEqual(edited.title, "Unsaved edit")
        XCTAssertEqual(edited.meetingID, existing.id)
        XCTAssertEqual(inserted.title, "Unsaved insert")
        XCTAssertEqual(inserted.meetingID, insertedID)
        let before = try rows(store)
        XCTAssertEqual(before.count, 1)
        XCTAssertEqual(before.first?.title, existing.title)
        try other.save()
        XCTAssertFalse(other.hasChanges)
        let after = try rows(store)
        XCTAssertEqual(after.count, 2)
        XCTAssertEqual(after.first(where: { $0.meetingID == existing.id })?.title, "Unsaved edit")
        XCTAssertEqual(after.first(where: { $0.meetingID == insertedID })?.title, "Unsaved insert")
    }

    @MainActor func testEmptyMeetingDoesNotCreateARowOrCommit() throws {
        let store = try container()
        try MeetingStore.save(Meeting(title: "Empty", startedAt: Date()), summary: nil, into: store) { _ in
            XCTFail("Empty meeting must not commit")
        }
        XCTAssertTrue(try rows(store).isEmpty)
    }

    @MainActor func testProductionControllerAndAdapterClearOnlyAfterAcknowledgement() async throws {
        let store = try container()
        var input = meeting()
        input.endedAt = nil
        let controller = MeetingController(intelligence: HeuristicIntelligence(), meeting: input)
        var fails = true
        controller.bindPersistence { meeting, summary in
            try MeetingStore.save(meeting, summary: summary, into: store) { context in
                if fails { throw PersistenceTestError.injected }
                try context.save()
            }
        }
        try await controller.startRecording()
        do {
            try await controller.stopRecording()
            XCTFail("Injected save failure must propagate")
        } catch {
            XCTAssertEqual(error as? MeetingOperationError, .saveFailed)
        }
        XCTAssertEqual(controller.meeting.id, input.id)
        XCTAssertEqual(controller.meeting.lines, input.lines)
        XCTAssertTrue(try rows(store).isEmpty)
        fails = false
        try await controller.stopRecording()
        XCTAssertNotEqual(controller.meeting.id, input.id)
        XCTAssertTrue(controller.meeting.lines.isEmpty)
        let saved = try rows(store)
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved.first?.meetingID, input.id)
        XCTAssertEqual(saved.first?.lines, input.lines)
    }

    @MainActor func testOwnedDiskStoreReopensWithExactTranscript() throws {
        let url = try diskFixture()
        let meeting = meeting()
        do {
            let first = try container(diskURL: url)
            try MeetingStore.save(meeting, summary: nil, into: first)
        }
        let reopened = try container(diskURL: url)
        let saved = try rows(reopened)
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved.first?.meetingID, meeting.id)
        XCTAssertEqual(saved.first?.lines, meeting.lines)
    }
}
