import Foundation
import SwiftUI
import Speech
import AVFoundation

/// Live in-room transcription via the Speech framework (on-device when available). iOS cannot tap
/// other apps' audio — this is the microphone, for in-person meetings.
@MainActor
final class SpeechTranscriber: ObservableObject {
    @Published var transcript: String = ""
    @Published var isRecording = false
    @Published var error: String?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Locale override — persisted so users can change it in Settings without re-launching.
    /// Defaults to the device locale at first launch.
    @AppStorage("speechLocale") private var speechLocaleIdentifier: String = Locale.current.identifier

    private var recognizer: SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: Locale(identifier: speechLocaleIdentifier))
    }

    func toggle() { isRecording ? stop() : start() }

    func start() {
        error = nil
        SFSpeechRecognizer.requestAuthorization { auth in
            AVAudioApplication.requestRecordPermission { granted in
                Task { @MainActor in
                    guard auth == .authorized, granted else {
                        self.error = "Grant Microphone + Speech Recognition in Settings."
                        return
                    }
                    self.begin()
                }
            }
        }
    }

    private func begin() {
        guard let recognizer, recognizer.isAvailable else { error = "Speech recognition unavailable."; return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
            request = req

            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in
                req.append(buf)
            }
            engine.prepare()
            try engine.start()
            isRecording = true

            task = recognizer.recognitionTask(with: req) { [weak self] result, err in
                Task { @MainActor in
                    if let r = result { self?.transcript = r.bestTranscription.formattedString }
                    if err != nil || (result?.isFinal ?? false) { self?.stop() }
                }
            }
        } catch {
            self.error = error.localizedDescription
            stop()
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        request?.endAudio()
        task?.cancel()
        request = nil; task = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func clear() { transcript = "" }
}
