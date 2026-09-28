import XCTest
@testable import MetisKit

/// M2-0412. Pins `OperatorDeviceAuth` to the exact wire format `src/shared/operator-hmac.ts` /
/// `src/main/operator-hmac-sign.ts` define, so a header signed here verifies on the Worker unchanged.
final class OperatorDeviceAuthTests: XCTestCase {
    func testSha256HexOfEmptyStringMatchesTheWellKnownConstant() {
        // The GET /v1/model-policy body is always "" — this is the exact bodySha256Hex every request uses.
        XCTAssertEqual(
            OperatorDeviceAuth.sha256Hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
    }

    func testCanonicalMatchesIngestCanonicalFormat() {
        XCTAssertEqual(
            OperatorDeviceAuth.canonical(ts: "1000", nonce: "abc", deviceId: "dev1", bodySha256Hex: "deadbeef"),
            "1000.abc.dev1.deadbeef"
        )
    }

    func testHmacHexIsDeterministicForTheSameInputs() {
        let a = OperatorDeviceAuth.hmacHex(secret: "shared-secret", message: "hello")
        let b = OperatorDeviceAuth.hmacHex(secret: "shared-secret", message: "hello")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.count, 64) // hex-encoded SHA-256
    }

    func testHmacHexChangesWithTheSecret() {
        let a = OperatorDeviceAuth.hmacHex(secret: "secret-a", message: "hello")
        let b = OperatorDeviceAuth.hmacHex(secret: "secret-b", message: "hello")
        XCTAssertNotEqual(a, b)
    }

    func testHashDeviceIdIsThirtyTwoLowercaseHexChars() {
        let id = OperatorDeviceAuth.hashDeviceId("some-durable-install-id")
        XCTAssertEqual(id.count, 32)
        XCTAssertTrue(id.allSatisfy { $0.isHexDigit && !$0.isUppercase })
    }

    func testHeadersCarryAllFourFieldsAndSignTheCanonicalString() {
        let headers = OperatorDeviceAuth.headers(secret: "shared-secret", deviceId: "dev1", body: "", ts: "1000", nonce: "nonce1")
        XCTAssertEqual(headers[OperatorDeviceAuth.tsHeader], "1000")
        XCTAssertEqual(headers[OperatorDeviceAuth.nonceHeader], "nonce1")
        XCTAssertEqual(headers[OperatorDeviceAuth.deviceHeader], "dev1")
        let expectedSig = OperatorDeviceAuth.hmacHex(
            secret: "shared-secret",
            message: OperatorDeviceAuth.canonical(ts: "1000", nonce: "nonce1", deviceId: "dev1", bodySha256Hex: OperatorDeviceAuth.sha256Hex(""))
        )
        XCTAssertEqual(headers[OperatorDeviceAuth.sigHeader], expectedSig)
    }

    func testHeadersSignatureChangesWhenTheBodyChanges() {
        let a = OperatorDeviceAuth.headers(secret: "s", deviceId: "d", body: "", ts: "1000", nonce: "n")
        let b = OperatorDeviceAuth.headers(secret: "s", deviceId: "d", body: "{\"x\":1}", ts: "1000", nonce: "n")
        XCTAssertNotEqual(a[OperatorDeviceAuth.sigHeader], b[OperatorDeviceAuth.sigHeader])
    }
}
