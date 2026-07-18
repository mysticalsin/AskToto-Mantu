#if canImport(Speech)
import Foundation
import Speech

/// On-device transcription via the Speech framework's `SpeechAnalyzer` + `SpeechTranscriber` (macOS 26 /
/// iOS 26 — the successor to `SFSpeechRecognizer`). Consumes a stream of `AnalyzerInput` (the app wraps its
/// captured PCM buffers into these on its single capture task — `AnalyzerInput` is `@unchecked Sendable`, so
/// the non-Sendable `AVAudioPCMBuffer` never crosses a concurrency boundary here) and yields finalized
/// `TranscriptLine` values as speech is recognized. `speaker` labels which side the audio is (mic → .me,
/// system loopback → .them). Zero API keys, fully on-device.
///
/// Lives in MetisKit (not the app target) so the Speech→text mapping compiles + is shape-verified against
/// the SDK here; the audio CAPTURE that produces the buffers stays in the app target (AVAudioEngine /
/// ScreenCaptureKit + entitlements + a device). Runtime behaviour still needs an Apple-Intelligence device.
@available(macOS 26.0, iOS 26.0, *)
public struct SpeechTranscription: Sendable {
    public init() {}

    /// Transcribe a stream of analyzer inputs into finalized transcript lines, running until the input ends
    /// or the consumer cancels. Best-effort model provisioning for `locale` first.
    public func transcribe(
        input: AsyncStream<AnalyzerInput>,
        speaker: TranscriptLine.Speaker,
        locale: Locale = .current
    ) -> AsyncThrowingStream<TranscriptLine, Error> {
        let (stream, continuation) = AsyncThrowingStream<TranscriptLine, Error>.makeStream()
        let work = Task {
            let transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: [],
                attributeOptions: []
            )
            do {
                // Provision the on-device model for this locale if it isn't installed yet.
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await request.downloadAndInstall()
                }
                let analyzer = SpeechAnalyzer(modules: [transcriber])
                try await analyzer.start(inputSequence: input)
                for try await result in transcriber.results where result.isFinal {
                    if Task.isCancelled { break }
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        continuation.yield(TranscriptLine(speaker: speaker, text: text, at: Date()))
                    }
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in work.cancel() }
        return stream
    }
}
#endif
