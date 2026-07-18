import Foundation
import AVFAudio
import MetisKit
#if canImport(Speech)
import Speech
#endif

/// Wires platform audio capture into the controller — roadmap step 2. The MIC path (ME) is the same on
/// macOS and iOS: AVAudioEngine mic tap → `AnalyzerInput` → `SpeechTranscription` (MetisKit, SDK-shape
/// verified) → `controller.beginTranscription`. The REMOTE side (THEM) needs macOS system-audio loopback
/// (ScreenCaptureKit) — the TODO below; iOS has no loopback API (Apple-forbidden), which is exactly why iOS
/// is the in-person companion. macOS therefore becomes the two-sided copilot once the loopback tap lands.
///
/// This file builds with Xcode (it needs AVAudioEngine + Speech + the mic entitlement + a device), NOT
/// `swift build` — the transcription core it drives is what MetisKit build-verifies. Concurrency
/// annotations around the non-Sendable AVAudioEngine may need tightening at first on-device build.
enum AudioCapture {
    @MainActor static func wire(into controller: MeetingController) {
        let engine = AVAudioEngine()

        controller.audioStart = { @MainActor in
            #if canImport(Speech)
            if #available(macOS 26.0, iOS 26.0, *) {
                // Mic buffers → AnalyzerInput stream (AnalyzerInput is @unchecked Sendable, so the non-
                // Sendable AVAudioPCMBuffer is wrapped on the capture thread and never crosses a boundary).
                let (inputs, inputCont) = AsyncStream<AnalyzerInput>.makeStream()
                let node = engine.inputNode
                let format = node.outputFormat(forBus: 0)
                node.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
                    inputCont.yield(AnalyzerInput(buffer: buffer))
                }
                engine.prepare()
                try engine.start()

                // Bridge the transcription's throwing line stream into the controller's (non-throwing) one.
                let lines = SpeechTranscription().transcribe(input: inputs, speaker: .me)
                let (out, outCont) = AsyncStream<TranscriptLine>.makeStream()
                Task {
                    do { for try await line in lines { outCont.yield(line) } } catch { /* end on error */ }
                    outCont.finish()
                }
                controller.beginTranscription(out)

                // TODO (roadmap 2b, macOS only): a second SCStream system-audio tap → AnalyzerInput stream →
                // SpeechTranscription(speaker: .them), merged so the mac build is the two-sided copilot.
            }
            #endif
        }

        controller.audioStop = { @MainActor in
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }
}
