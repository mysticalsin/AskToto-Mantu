import XCTest
@testable import MetisKit

/// M2-0412. `testCanonicalPayloadMatchesTypeScript` pins the exact wire format both platforms must
/// reproduce byte-for-byte — the identical literal is asserted on the TypeScript side in
/// src/shared/model-policy.test.ts ("matches the exact wire format ... ModelPolicy.swift's
/// canonicalPayload must reproduce byte-for-byte"). If either side's format ever drifts, that test or
/// this one fails first, before a real signature mismatch ships.
final class ModelPolicyTests: XCTestCase {
    private func entry(_ provider: String = "anthropic", _ model: String = "claude-sonnet-4-6") -> ModelPolicyEntry {
        ModelPolicyEntry(provider: provider, model: model)
    }

    private func fullDocument(updatedAt: Int = 1000, updatedBy: String = "owner@example.com", overrides: [ModelPolicyCapability: ModelPolicyEntry] = [:]) -> ModelPolicyDocument {
        var capabilities: [String: ModelPolicyEntry] = [:]
        for capability in modelPolicyCapabilityOrder {
            capabilities[capability.rawValue] = overrides[capability] ?? entry()
        }
        return ModelPolicyDocument(version: updatedAt, updatedAt: updatedAt, updatedBy: updatedBy, capabilities: capabilities)
    }

    func testCanonicalPayloadMatchesTypeScript() {
        let doc = fullDocument()
        let expected = "metis-model-policy.v1.1000.1000.owner@example.com." +
            "askChat=anthropic:claude-sonnet-4-6[]|" +
            "commandAgent=anthropic:claude-sonnet-4-6[]|" +
            "recap=anthropic:claude-sonnet-4-6[]|" +
            "stt=anthropic:claude-sonnet-4-6[]|" +
            "tts=anthropic:claude-sonnet-4-6[]|" +
            "embeddings=anthropic:claude-sonnet-4-6[]|" +
            "localModel=anthropic:claude-sonnet-4-6[]"
        XCTAssertEqual(ModelPolicy.canonicalPayload(doc), expected)
    }

    func testCanonicalPayloadChangesWithFallbacks() {
        let withFallback = fullDocument(overrides: [
            .askChat: ModelPolicyEntry(provider: "anthropic", model: "x", fallbacks: [ModelPolicyFallback(provider: "openai", model: "gpt-5")])
        ])
        let withoutFallback = fullDocument(overrides: [.askChat: ModelPolicyEntry(provider: "anthropic", model: "x")])
        XCTAssertNotEqual(ModelPolicy.canonicalPayload(withFallback), ModelPolicy.canonicalPayload(withoutFallback))
        XCTAssertTrue(ModelPolicy.canonicalPayload(withFallback).contains("[openai:gpt-5]"))
    }

    func testSignAndVerifyRoundTrip() {
        let doc = fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let signed = SignedModelPolicy(policy: doc, signature: signature)
        XCTAssertTrue(ModelPolicy.verify(signed, secret: "shared-secret"))
    }

    func testSignedUnmanagedPayloadRoundTrip() {
        let signature = ModelPolicy.signUnmanaged(issuedAt: 2000, secret: "shared-secret")
        XCTAssertTrue(ModelPolicy.verifyUnmanaged(issuedAt: 2000, signature: signature, secret: "shared-secret"))
        XCTAssertFalse(ModelPolicy.verifyUnmanaged(issuedAt: 2001, signature: signature, secret: "shared-secret"))
        XCTAssertFalse(ModelPolicy.verifyUnmanaged(issuedAt: 2000, signature: signature, secret: "wrong-secret"))
    }

    func testVerifyRejectsWrongSecret() {
        let doc = fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let signed = SignedModelPolicy(policy: doc, signature: signature)
        XCTAssertFalse(ModelPolicy.verify(signed, secret: "wrong-secret"))
    }

    func testVerifyRejectsTamperedDocument() {
        let doc = fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let tampered = fullDocument(overrides: [.askChat: ModelPolicyEntry(provider: "openai", model: "gpt-5")])
        let signed = SignedModelPolicy(policy: tampered, signature: signature)
        XCTAssertFalse(ModelPolicy.verify(signed, secret: "shared-secret"))
    }

    func testVerifyRejectsIncompleteDocument() {
        var capabilities: [String: ModelPolicyEntry] = [:]
        capabilities[ModelPolicyCapability.askChat.rawValue] = entry()
        let incomplete = ModelPolicyDocument(version: 1, updatedAt: 1, updatedBy: "owner", capabilities: capabilities)
        XCTAssertFalse(incomplete.isComplete)
        let signature = ModelPolicy.sign(incomplete, secret: "shared-secret")
        XCTAssertFalse(ModelPolicy.verify(SignedModelPolicy(policy: incomplete, signature: signature), secret: "shared-secret"))
    }
}

/// `ModelPolicyClient` behaviour: fetch/verify/cache/offline, via an injected fetch function so no
/// test touches the real network or a real device secret.
final class ModelPolicyClientTests: XCTestCase {
    // static, and never capturing `self`: these run inside `@Sendable` fetch closures, and XCTestCase
    // itself is not Sendable — capturing it (even implicitly, by calling an instance method from the
    // closure) would be a Swift 6 strict-concurrency error.
    private static func tempCacheURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("model-policy-cache-\(UUID().uuidString).json")
    }

    private static func jsonResponse(_ object: [String: Any], url: URL) -> (Data, URLResponse) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        return (data, response)
    }

    private static func encodableJson(_ signed: SignedModelPolicy) -> [String: Any] {
        let data = try! JSONEncoder().encode(signed)
        var object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let policy = object.removeValue(forKey: "policy")
        return ["ok": true, "policy": policy as Any, "signature": object["signature"] as Any]
    }

    private static func fullDocument(overrides: [ModelPolicyCapability: ModelPolicyEntry] = [:]) -> ModelPolicyDocument {
        var capabilities: [String: ModelPolicyEntry] = [:]
        for capability in modelPolicyCapabilityOrder {
            capabilities[capability.rawValue] = overrides[capability] ?? ModelPolicyEntry(provider: "anthropic", model: "claude-sonnet-4-6")
        }
        return ModelPolicyDocument(version: 1000, updatedAt: 1000, updatedBy: "owner@example.com", capabilities: capabilities)
    }

    /// A plain mutable box for a fetch closure's fail/succeed toggle. `@unchecked Sendable`: the tests
    /// below only ever mutate it between sequential `await`s on one Task, never from two threads at
    /// once, but the compiler cannot see that from a stored closure alone.
    private final class FailSwitch: @unchecked Sendable {
        var shouldFail = false
    }

    func testRefreshAppliesAVerifiedPolicy() async {
        let doc = Self.fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            Self.jsonResponse(Self.encodableJson(SignedModelPolicy(policy: doc, signature: signature)), url: url)
        }
        let outcome = await client.refresh(url: url, secret: "shared-secret")
        XCTAssertEqual(outcome, .applied)
        let active = await client.activePolicy()
        XCTAssertEqual(active?.version, 1000)
    }

    func testRefreshRejectsWrongSignatureAndDoesNotApply() async {
        let doc = Self.fullDocument()
        let wrongSignature = ModelPolicy.sign(doc, secret: "different-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            Self.jsonResponse(Self.encodableJson(SignedModelPolicy(policy: doc, signature: wrongSignature)), url: url)
        }
        let outcome = await client.refresh(url: url, secret: "shared-secret")
        if case .rejected = outcome {} else { XCTFail("expected .rejected, got \(outcome)") }
        let active = await client.activePolicy()
        XCTAssertNil(active)
    }

    func testRefreshTreatsNullPolicyAsNotManaged() async {
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            Self.jsonResponse([
                "ok": true,
                "policy": NSNull(),
                "issuedAt": 2000,
                "signature": ModelPolicy.signUnmanaged(issuedAt: 2000, secret: "shared-secret")
            ], url: url)
        }
        let outcome = await client.refresh(url: url, secret: "shared-secret")
        XCTAssertEqual(outcome, .notManaged)
    }

    func testRefreshRejectsUnsignedNullPolicyAndKeepsCachedPolicy() async {
        let doc = Self.fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let failSwitch = FailSwitch()
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            if failSwitch.shouldFail {
                return Self.jsonResponse(["ok": true, "policy": NSNull()], url: url)
            }
            return Self.jsonResponse(Self.encodableJson(SignedModelPolicy(policy: doc, signature: signature)), url: url)
        }
        XCTAssertEqual(await client.refresh(url: url, secret: "shared-secret"), .applied)
        failSwitch.shouldFail = true
        let outcome = await client.refresh(url: url, secret: "shared-secret")
        if case .rejected = outcome {} else { XCTFail("expected .rejected, got \(outcome)") }
        let active = await client.activePolicy()
        XCTAssertEqual(active?.version, 1000)
    }

    func testRefreshIgnoresReplayedSignedNullPolicyOlderThanCachedPolicy() async {
        let doc = Self.fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let failSwitch = FailSwitch()
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            if failSwitch.shouldFail {
                return Self.jsonResponse([
                    "ok": true,
                    "policy": NSNull(),
                    "issuedAt": 999,
                    "signature": ModelPolicy.signUnmanaged(issuedAt: 999, secret: "shared-secret")
                ], url: url)
            }
            return Self.jsonResponse(Self.encodableJson(SignedModelPolicy(policy: doc, signature: signature)), url: url)
        }
        XCTAssertEqual(await client.refresh(url: url, secret: "shared-secret"), .applied)
        failSwitch.shouldFail = true
        XCTAssertEqual(await client.refresh(url: url, secret: "shared-secret"), .notManaged)
        let active = await client.activePolicy()
        XCTAssertEqual(active?.version, 1000)
    }

    func testCachePersistsAcrossClientInstancesForOfflineUse() async {
        let doc = Self.fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let cacheURL = Self.tempCacheURL()
        defer { try? FileManager.default.removeItem(at: cacheURL) }
        let firstClient = ModelPolicyClient(cacheURL: cacheURL) { _ in
            Self.jsonResponse(Self.encodableJson(SignedModelPolicy(policy: doc, signature: signature)), url: url)
        }
        _ = await firstClient.refresh(url: url, secret: "shared-secret")

        // Simulate a relaunch: a brand new client instance, nothing fetched yet, loads from disk.
        let secondClient = ModelPolicyClient(cacheURL: cacheURL) { _ in
            throw URLError(.notConnectedToInternet)
        }
        await secondClient.loadCached(secret: "shared-secret")
        let active = await secondClient.activePolicy()
        XCTAssertEqual(active?.version, 1000)
    }

    func testNetworkFailureLeavesLastVerifiedPolicyInPlace() async {
        let doc = Self.fullDocument()
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let failSwitch = FailSwitch()
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            if failSwitch.shouldFail { throw URLError(.timedOut) }
            return Self.jsonResponse(Self.encodableJson(SignedModelPolicy(policy: doc, signature: signature)), url: url)
        }
        _ = await client.refresh(url: url, secret: "shared-secret")
        failSwitch.shouldFail = true
        let outcome = await client.refresh(url: url, secret: "shared-secret")
        XCTAssertEqual(outcome, .networkError)
        let active = await client.activePolicy()
        XCTAssertEqual(active?.version, 1000)
    }
}

/// `ModelPolicyRuntime`: the poll loop that drives `ModelPolicyClient` from app launch — proves the
/// loop actually calls `refresh` when wired up (the gap this test file closes: before M2-0412's native
/// wiring, nothing in `native-app/App/` ever called this client at all). `sleepFn` is injected so no
/// test waits out a real 60s poll interval.
final class ModelPolicyRuntimeTests: XCTestCase {
    /// Same reasoning as `ModelPolicyClientTests.FailSwitch`: mutated from a `@Sendable` closure on one
    /// Task at a time, never from two threads concurrently, but the compiler cannot see that alone.
    private final class Counter: @unchecked Sendable {
        var refreshCalls = 0
        var secretCalls = 0
    }

    private static func tempCacheURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("model-policy-runtime-\(UUID().uuidString).json")
    }

    /// Gives the runtime's background `Task` a scheduling window to run its first loop iteration before
    /// the test asserts and tears down. Not fully deterministic, but generous enough that a normal CI
    /// runner's scheduler reaches the first `await` well within it.
    private static func letLoopRunOnce() async {
        try? await Task.sleep(for: .milliseconds(200))
    }

    func testStartSkipsRefreshWhenNoSecretIsConfiguredYet() async {
        let counter = Counter()
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            counter.refreshCalls += 1
            throw URLError(.notConnectedToInternet)
        }
        let runtime = ModelPolicyRuntime(client: client) { _ in throw CancellationError() }
        await runtime.start(url: url) {
            counter.secretCalls += 1
            return nil // no device credential provisioned yet — see OperatorDeviceAuth's doc comment
        }
        await Self.letLoopRunOnce()
        await runtime.stop()
        XCTAssertEqual(counter.secretCalls, 1)
        XCTAssertEqual(counter.refreshCalls, 0)
    }

    func testStartCallsRefreshOnceASecretIsConfigured() async {
        let counter = Counter()
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            counter.refreshCalls += 1
            throw URLError(.notConnectedToInternet)
        }
        let runtime = ModelPolicyRuntime(client: client) { _ in throw CancellationError() }
        await runtime.start(url: url) { "shared-secret" }
        await Self.letLoopRunOnce()
        await runtime.stop()
        XCTAssertEqual(counter.refreshCalls, 1)
    }

    func testStopCancelsTheLoopSoAPendingSleepNeverFiresAnotherRefresh() async {
        let counter = Counter()
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { _ in
            counter.refreshCalls += 1
            throw URLError(.notConnectedToInternet)
        }
        // A real, long sleep: only cancellation (from stop()) ends it before the test's own timeout would.
        let runtime = ModelPolicyRuntime(client: client) { duration in try await Task.sleep(for: duration) }
        await runtime.start(url: url, pollInterval: .seconds(3600)) { "shared-secret" }
        await Self.letLoopRunOnce()
        await runtime.stop()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(counter.refreshCalls, 1) // only the immediate refresh — the hour-long sleep never fired again
    }

    func testActivePolicyReflectsWhatTheClientApplied() async {
        var capabilities: [String: ModelPolicyEntry] = [:]
        for capability in modelPolicyCapabilityOrder {
            capabilities[capability.rawValue] = ModelPolicyEntry(provider: "anthropic", model: "claude-sonnet-4-6")
        }
        let doc = ModelPolicyDocument(version: 7, updatedAt: 7, updatedBy: "owner@example.com", capabilities: capabilities)
        let signature = ModelPolicy.sign(doc, secret: "shared-secret")
        let url = URL(string: "https://operator.test/v1/model-policy")!
        let client = ModelPolicyClient(cacheURL: Self.tempCacheURL()) { fetchedURL in
            let data = try! JSONSerialization.data(withJSONObject: [
                "ok": true,
                "policy": try! JSONSerialization.jsonObject(with: JSONEncoder().encode(doc)),
                "signature": signature
            ])
            return (data, HTTPURLResponse(url: fetchedURL, statusCode: 200, httpVersion: nil, headerFields: ["content-type": "application/json"])!)
        }
        let runtime = ModelPolicyRuntime(client: client) { _ in throw CancellationError() }
        await runtime.start(url: url) { "shared-secret" }
        await Self.letLoopRunOnce()
        await runtime.stop()
        let active = await runtime.activePolicy()
        XCTAssertEqual(active?.version, 7)
    }
}
