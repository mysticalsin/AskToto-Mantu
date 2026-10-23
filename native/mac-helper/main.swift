// metis-mac-helper — dependency-free macOS sidecar for Métis (compiled by scripts/build-mac-helper.mjs,
// shipped via electron-builder's mac extraResources; mirrors the llama-server sidecar pattern).
//
// Subcommands, each spawned by the main process:
//
//   watch-frontmost   Long-running. Prints one TSV line per app activation — the SAME
//                     `windowId \t pid \t title` shape foreground-watcher.ts already parses from the
//                     Windows PowerShell watcher (windowId = bundle id on mac; app-level granularity —
//                     intra-app tab/window switches are covered by screen-preprocess's 6s content
//                     re-check, so AX permissions are deliberately NOT required here).
//
//   ocr [path|-]      One-shot. Reads an image (file path, or stdin with '-'), runs Vision's
//                     VNRecognizeTextRequest (accurate mode; GA API for years, deterministic), prints
//                     one JSON object {width, height, lines:[{text, confidence, box:[x,y,w,h]}]} and
//                     exits. box is Vision-normalized (origin bottom-left, 0..1) — the TS consumer
//                     sorts top-to-bottom. Spawn-per-call: OCR is throttled upstream (≥2.5s between
//                     describes), so a ~100ms process start is cheaper than keeping a server alive.
//
//   transcribe <wav> [locale]  One-shot. Runs Apple's Speech framework (SFSpeechRecognizer) fully
//                     on-device over a 16kHz mono WAV file and prints the plain-text transcription to
//                     stdout. The optional locale (BCP-47, e.g. pt-BR) pins the recognizer's language
//                     — the app's spoken-language setting — falling back to the system locale. No Apple
//                     Intelligence toggle required — SFSpeechRecognizer has shipped on-device dictation
//                     since macOS 13. Mirrors the batch-per-window contract the Parakeet ASR engine
//                     already uses (see main/apple-speech.ts): one call in, one text result out.
//
//   screen-metrics    One-shot. Enumerates NSScreen.screens and prints ONE JSON object
//                     {screens:[{displayID, frame, visibleFrame, safeAreaInsetTop, auxLeftWidth,
//                     auxRightWidth, notchWidth, backingScaleFactor}, ...]} to stdout. Feeds the
//                     Métis-island notch-aware top clamp (src/main/island/metrics.ts): displayID IS the
//                     CGDirectDisplayID, which is exactly Electron's `Display.id` on macOS, so the
//                     TypeScript side joins by id directly — no heuristic display matching needed.
//                     `frame`/`visibleFrame` are AppKit rects (bottom-left origin) — the TS side must
//                     NEVER treat them as Electron bounds/workArea (top-left origin); only the magnitude
//                     fields (notchWidth, safeAreaInsetTop, backingScaleFactor) cross that boundary.
//
//   stat-flags        One-shot. Reads NUL-separated UTF-8 paths from stdin and prints ONE JSON array
//                     holding each path's st_flags, or null where stat(2) failed, in input order.
//                     stat(2) reads the inode and never opens the file, so probing a dataless
//                     (cloud-only) file cannot materialize it. src/main/infra/storage/dataless.ts owns
//                     the protocol and decodes SF_DATALESS; this command reports the raw word.
//
//   proc-info <pid>   One-shot. Prints process identity JSON for PID if alive:
//                     {pid, ppid, pgid, osStartTime, exeRealpath, args}. osStartTime is the kernel start
//                     time in ISO-8601 UTC. Used by the sidecar registry/reaper; name is deliberately not
//                     part of the identity, because names are not safe across PID reuse.
//
//   supervise --parent <pid> -- <cmd> [args...]  Long-running wrapper. Creates a process group, spawns
//                     <cmd> with inherited stdout/stderr, watches <pid> with kqueue NOTE_EXIT, and
//                     kills the process group if the parent dies. This is the source-of-orphan fix for
//                     local sidecars; the registry/reaper remains the next-launch safety net.
//
//   stall-watch       Long-running, one per boot. --pid <main> --alive <file> --capture-prefix <path>
//                     --stale-after-ms <ms>. Every 5 s it stats <file>; when its mtime has not changed
//                     for more than <ms> of awake time it runs /usr/bin/sample on <main> into
//                     <path>.<epochMs>.<stalledMs>.sample, once per stall and at most once per 10 minutes,
//                     then prints `sampled` or `failed`. It samples only its own parent and exits once
//                     <main> is no longer its parent. src/main/infra/observability/stall-sampler.ts owns
//                     the protocol; all redaction, retention and auditing happen there, not here.
//
//   code-identity <path>  One-shot, read-only. Reads the static code signature of <path> (an app bundle or a
//                     binary) and prints ONE JSON object {identifier, cdhash, teamId, adhoc}. cdhash is the
//                     lowercase hex code-directory hash macOS pins Screen Recording to for an ad-hoc build;
//                     it is "" for unsigned code. src/main/capture-permissions uses it to tell a grant held
//                     by another build from a plain denial. Never touches the permissions database.
//
//   bundle-copies <bundle-id>  One-shot, read-only. Asks LaunchServices for every installed app with that
//                     bundle id and prints ONE JSON object {copies:[{path, version}]}. Several copies with one
//                     bundle id compete for one Screen Recording entry.
//
//   tcc-status <listen-event|automation> [bundle-id]  One-shot, read-only. Preflights one privacy permission
//                     WITHOUT raising a system prompt and prints ONE JSON object {status} where status is
//                     "granted", "denied" or "unknown". listen-event is Input Monitoring
//                     (CGPreflightListenEventAccess; there is no request call here). automation asks whether
//                     this app may send Apple Events to <bundle-id> (AEDeterminePermissionToAutomateTarget with
//                     askUserIfNeeded=false): "unknown" when the user has not been asked yet or the target is
//                     not running. Accessibility is probed in-process by Electron, so it is not here.
//   automation-ask <bundle-id>  One-shot (V04). The ONLY call here that may raise a system prompt: it asks
//                     whether this app may send Apple Events to <bundle-id> (AEDeterminePermissionToAutomateTarget
//                     with askUserIfNeeded=true) and prints ONE JSON object {status} like tcc-status. Metis calls
//                     it after the person pressed Return and before anything is dispatched, so a prompt still being
//                     read can never turn into an uncertain effect. tcc-status stays read-only.
//   activate-pid <pid>  One-shot (V04). Brings the running application with that pid to the front again, so a
//                     confirmation card hands focus back to the app the person was in. Prints {activated}.
//   ax-focus-snapshot  One-shot, read-only (G23). Looks at the frontmost application's focused element WITHOUT any
//                     prompt (AXIsProcessTrusted) and prints ONE JSON object: status (ok|permission|no_focus), pid,
//                     bundle id, process start, an opaque window id and element token, role/subrole, secure,
//                     editable and terminal flags, and the value as a SHA-256 hash plus its UTF-16 length and the
//                     selection range. The text of the field is never printed, and the value of a secure field
//                     (AXSecureTextField, or secure keyboard input on) is never even read.
//   ax-insert         One-shot (G23). Reads ONE JSON request on stdin (pid, window id, element token, value hash and
//                     length, selection, text): it looks again, refuses secure fields always, refuses unless process,
//                     window, element, value hash and selection all still match (compare-and-insert), then writes by
//                     replacing the selected text through Accessibility, reads the value back and reports whether
//                     it is exactly the expected one. Only when Accessibility refused the write does it fall back to
//                     a paste: it writes the clipboard, keeps the change count as an ownership token, pastes, and
//                     restores the previous clipboard only if the change count is still its token. Terminals take
//                     the paste only, with control characters removed and no Return. Prints ONE JSON object.
//   watch-modifiers [--interval-ms N]  Long-running, permission-free (V01, the voice hold chord). Polls two idle
//                     state queries every N ms (default 40, clamped to 20-200): which modifier keys are down
//                     (CGEventSource.flagsState, device-dependent bits kept so Right Command differs from Left)
//                     and a wrapping counter of other key-down, mouse-down and scroll events
//                     (CGEventSource.counterForEventType). It prints ONE line `m <mask> <seq>` only when either
//                     changed, plus one on start, and exits when its parent dies. There is no event tap, no
//                     global monitor and no Input Monitoring request, and the protocol has no field for a key
//                     code: a key press only moves the counter. src/shared/voice/modifier-mask.ts owns the
//                     line format and the bit values below.
//
//   speak --voice <id> [--rate <0.5-1.5>]  One-shot (G27). Reads text from stdin, speaks with an installed
//                     AVSpeechSynthesizer voice, and emits started/ended/cancelled or a machine error line. SIGTERM
//                     stops immediately; speech never outlives its parent. Text is never passed in argv.
//
//   speak-voices      One-shot, read-only. Prints installed voices as JSON {voices:[{id,name,language}]}; it never
//                     downloads or requests a voice.
import AppKit
import AVFoundation
import ApplicationServices
import Carbon.HIToolbox
import CryptoKit
import Darwin
import Security
import Speech
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

// MARK: - watch-frontmost

func emitFrontmost(_ app: NSRunningApplication?) {
    guard let app else { return }
    // Tabs are the field separator — strip them from free-text fields (same rule as the PS watcher).
    let bundle = (app.bundleIdentifier ?? "pid-\(app.processIdentifier)")
        .replacingOccurrences(of: "\t", with: " ")
    let name = (app.localizedName ?? "").replacingOccurrences(of: "\t", with: " ")
    print("\(bundle)\t\(app.processIdentifier)\t\(name)")
    fflush(stdout)
}

func watchFrontmost() -> Never {
    // Exit the moment the launching process dies: this watcher only prints on app activation, so without the
    // parent watch a hard-killed main would leave it running until its next write hits a closed pipe.
    let parent = getppid()
    let parentWatch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    parentWatch.setEventHandler { exit(0) }
    parentWatch.resume()
    if getppid() != parent { exit(0) }
    // Emit the current app immediately so the consumer has initial state without waiting for a switch.
    emitFrontmost(NSWorkspace.shared.frontmostApplication)
    NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification,
        object: nil,
        queue: .main
    ) { note in
        emitFrontmost(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }
    RunLoop.main.run()
    exit(0)
}

// MARK: - watch-modifiers

// Bit values of the `m <mask> <seq>` protocol. Mirrored in src/shared/voice/modifier-mask.ts (MODIFIER_BITS) and
// pinned by src/main/voice/chord-helper.contract.test.ts.
let modLeftControl = 1
let modRightControl = 2
let modLeftOption = 4
let modRightOption = 8
let modLeftCommand = 16
let modRightCommand = 32
let modLeftShift = 64
let modRightShift = 128
let modFn = 256
let modUnsided = 512

// Device-dependent flag bits (IOKit NX_DEVICE*KEYMASK). They ride in the low bits of the flags word and say which
// physical side is down. The device-independent CGEventFlags masks say that a family is down at all.
let nxDeviceLeftControl: UInt64 = 0x1
let nxDeviceLeftShift: UInt64 = 0x2
let nxDeviceRightShift: UInt64 = 0x4
let nxDeviceLeftCommand: UInt64 = 0x8
let nxDeviceRightCommand: UInt64 = 0x10
let nxDeviceLeftOption: UInt64 = 0x20
let nxDeviceRightOption: UInt64 = 0x40
let nxDeviceRightControl: UInt64 = 0x2000

/// Reduces a raw CGEventFlags word to the protocol mask. A family reported as down with neither device bit gets
/// `modUnsided`, which never matches a sided chord: if this macOS does not expose sides, the chord simply never
/// fires (fail closed) and the owner spike catches it. Caps Lock and the numeric-pad flag are ignored.
func modifierMask(rawFlags: UInt64) -> Int {
    var mask = 0
    var unsided = false
    func family(_ independent: CGEventFlags, left: UInt64, right: UInt64, leftBit: Int, rightBit: Int) {
        guard rawFlags & independent.rawValue != 0 else { return }
        let leftDown = rawFlags & left != 0
        let rightDown = rawFlags & right != 0
        if leftDown { mask |= leftBit }
        if rightDown { mask |= rightBit }
        if !leftDown && !rightDown { unsided = true }
    }
    family(.maskControl, left: nxDeviceLeftControl, right: nxDeviceRightControl, leftBit: modLeftControl, rightBit: modRightControl)
    family(.maskAlternate, left: nxDeviceLeftOption, right: nxDeviceRightOption, leftBit: modLeftOption, rightBit: modRightOption)
    family(.maskCommand, left: nxDeviceLeftCommand, right: nxDeviceRightCommand, leftBit: modLeftCommand, rightBit: modRightCommand)
    family(.maskShift, left: nxDeviceLeftShift, right: nxDeviceRightShift, leftBit: modLeftShift, rightBit: modRightShift)
    if rawFlags & CGEventFlags.maskSecondaryFn.rawValue != 0 { mask |= modFn }
    if unsided { mask |= modUnsided }
    return mask
}

/// One wrapping sum of the "something else was pressed" counters. Only the fact that it moved is used.
func otherInputCounter() -> UInt32 {
    let state = CGEventSourceStateID.combinedSessionState
    let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
    return types.reduce(UInt32(0)) { $0 &+ CGEventSource.counterForEventType(state, eventType: $1) }
}

func watchModifiers(_ options: [String]) -> Never {
    var intervalMs = 40
    var index = 0
    while index < options.count {
        guard options[index] == "--interval-ms", index + 1 < options.count, let value = Int(options[index + 1]) else {
            fail("usage: metis-mac-helper watch-modifiers [--interval-ms N]")
        }
        intervalMs = min(200, max(20, value))
        index += 2
    }
    // Exit the moment the launching process dies: this only prints on change, so a hard-killed main would
    // otherwise leave it polling until its next write hits a closed pipe.
    let parent = getppid()
    let parentWatch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    parentWatch.setEventHandler { exit(0) }
    parentWatch.resume()
    if getppid() != parent { exit(0) }
    var last: (Int, UInt32)? = nil
    func poll() {
        let mask = modifierMask(rawFlags: CGEventSource.flagsState(.combinedSessionState).rawValue)
        let seq = otherInputCounter()
        if last == nil || last!.0 != mask || last!.1 != seq {
            last = (mask, seq)
            print("m \(mask) \(seq)")
            fflush(stdout)
        }
    }
    poll()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + .milliseconds(intervalMs), repeating: .milliseconds(intervalMs), leeway: .milliseconds(10))
    timer.setEventHandler { poll() }
    timer.resume()
    RunLoop.main.run()
    exit(0)
}

// MARK: - ocr

struct OcrLine: Codable {
    let text: String
    let confidence: Double
    let box: [Double]
}

struct OcrResult: Codable {
    let width: Int
    let height: Int
    let lines: [OcrLine]
}

func runOcr(inputPath: String) -> Never {
    let data: Data
    if inputPath == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        guard let fileData = FileManager.default.contents(atPath: inputPath) else {
            fail("ocr: could not read \(inputPath)")
        }
        data = fileData
    }
    guard !data.isEmpty,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("ocr: input is not a decodable image")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("ocr: \(error.localizedDescription)")
    }

    var lines: [OcrLine] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        lines.append(
            OcrLine(
                text: candidate.string,
                confidence: Double(candidate.confidence),
                box: [box.origin.x, box.origin.y, box.size.width, box.size.height]
            )
        )
    }

    let result = OcrResult(width: image.width, height: image.height, lines: lines)
    do {
        let encoded = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("ocr: could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}

// MARK: - transcribe

/// One-shot, fully on-device speech-to-text over a WAV file via SFSpeechRecognizer. Never sends audio
/// off-device: requiresOnDeviceRecognition is forced true, so this either transcribes locally or fails —
/// it never silently falls back to Apple's cloud recognizer. Any failure (missing file, no on-device
/// model for this locale, authorization denied, timeout) prints to stderr and exits non-zero; the TS
/// caller (apple-speech.ts) treats that as "no result" and the app falls back to another ASR engine.
func runTranscribe(path: String, localeIdentifier: String?) -> Never {
    guard FileManager.default.fileExists(atPath: path) else {
        fail("transcribe: file not found at \(path)")
    }

    // Locale precedence: the caller's explicit identifier (the app's spoken-language setting — a system
    // locale says nothing about what language a meeting is held in) → the user's current locale → en-US
    // (always available). SFSpeechRecognizer returns nil for a locale it has no model for, so each step
    // falls through instead of failing outright.
    let requested = localeIdentifier.flatMap { SFSpeechRecognizer(locale: Locale(identifier: $0)) }
    guard let recognizer = requested ?? SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
        fail("transcribe: no speech recognizer available for this Mac")
    }
    guard recognizer.supportsOnDeviceRecognition else {
        fail("transcribe: on-device recognition is not available for this language on this Mac")
    }

    // SFSpeechRecognizer.requestAuthorization's completion handler queue is not documented, so this
    // waits by pumping the run loop rather than blocking on a semaphore — safe whether the callback
    // lands on the main queue or a background one (a semaphore would risk a main-thread deadlock if a
    // future OS ever dispatches it back onto the main queue), and still bounded to ~15s so a stuck
    // authorization prompt can never hang the caller forever.
    var authStatus: SFSpeechRecognizerAuthorizationStatus?
    SFSpeechRecognizer.requestAuthorization { status in authStatus = status }
    let authDeadline = Date().addingTimeInterval(15)
    while authStatus == nil && Date() < authDeadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    switch authStatus {
    case .authorized:
        break
    case .denied, .restricted:
        fail("transcribe: speech recognition access denied")
    default:
        fail("transcribe: speech recognition authorization timed out")
    }

    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false

    var finalText: String?
    var recognitionError: Error?
    var finished = false
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let error {
            recognitionError = error
            finished = true
            return
        }
        if let result, result.isFinal {
            finalText = result.bestTranscription.formattedString
            finished = true
        }
    }

    let resultDeadline = Date().addingTimeInterval(15)
    while !finished && Date() < resultDeadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    if !finished {
        task.cancel()
        fail("transcribe: recognition timed out")
    }
    if let recognitionError {
        fail("transcribe: \(recognitionError.localizedDescription)")
    }
    print(finalText ?? "")
    fflush(stdout)
    exit(0)
}

// MARK: - screen-metrics

struct ScreenMetric: Codable {
    let displayID: UInt32
    /// [x, y, width, height] — AppKit NSScreen coordinate space (origin bottom-left of the primary
    /// screen). NOT Electron's Display.bounds coordinate space (origin top-left) — see this file's
    /// header comment and island/metrics.ts's header for why the TS side never uses this for placement.
    let frame: [Double]
    /// Same shape as `frame`, minus the menu bar and Dock (AppKit's own `visibleFrame`).
    let visibleFrame: [Double]
    /// `NSScreen.safeAreaInsets.top` — the menu-bar/notch obstruction height, in points.
    let safeAreaInsetTop: Double
    /// `NSScreen.auxiliaryTopLeftArea.width`, or 0 when the API reports none (non-notch screen).
    let auxLeftWidth: Double
    /// `NSScreen.auxiliaryTopRightArea.width`, or 0 when the API reports none (non-notch screen).
    let auxRightWidth: Double
    /// 0 on a non-notch screen (both aux areas absent); otherwise `frame.width - (auxLeft + auxRight)`.
    let notchWidth: Double
    let backingScaleFactor: Double
}

struct ScreenMetricsResult: Codable {
    let screens: [ScreenMetric]
}

/// `NSScreen.deviceDescription[.init("NSScreenNumber")]` IS the `CGDirectDisplayID` — the same id
/// Electron's `Display.id` exposes on macOS (see Electron's own screen.ts), so main/island/metrics.ts
/// joins on this value directly with no heuristic bounds-overlap matching required.
private let screenNumberKey = NSDeviceDescriptionKey("NSScreenNumber")

func runScreenMetrics() -> Never {
    var screens: [ScreenMetric] = []
    for screen in NSScreen.screens {
        guard let number = screen.deviceDescription[screenNumberKey] as? NSNumber else { continue }
        let frame = screen.frame
        let visible = screen.visibleFrame
        // auxiliaryTopLeftArea/auxiliaryTopRightArea are non-nil ONLY on a notched screen (macOS 12+);
        // both nil means "no notch API surface at all" for this screen, which must report notchWidth 0 —
        // NOT frame.width (which plugging 0-width aux areas into the subtraction below would produce).
        let leftArea = screen.auxiliaryTopLeftArea
        let rightArea = screen.auxiliaryTopRightArea
        let leftWidth = Double(leftArea?.width ?? 0)
        let rightWidth = Double(rightArea?.width ?? 0)
        let notchWidth: Double = (leftArea == nil && rightArea == nil)
            ? 0
            : max(0, Double(frame.width) - (leftWidth + rightWidth))
        screens.append(
            ScreenMetric(
                displayID: number.uint32Value,
                frame: [Double(frame.origin.x), Double(frame.origin.y), Double(frame.width), Double(frame.height)],
                visibleFrame: [
                    Double(visible.origin.x), Double(visible.origin.y), Double(visible.width), Double(visible.height)
                ],
                safeAreaInsetTop: Double(screen.safeAreaInsets.top),
                auxLeftWidth: leftWidth,
                auxRightWidth: rightWidth,
                notchWidth: notchWidth,
                backingScaleFactor: Double(screen.backingScaleFactor)
            )
        )
    }
    let result = ScreenMetricsResult(screens: screens)
    do {
        let encoded = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("screen-metrics: could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}

// MARK: - stat-flags

func runStatFlags() -> Never {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let flags: [UInt32?] = input.split(separator: 0).map { pathBytes in
        var info = stat()
        let path = String(decoding: pathBytes, as: UTF8.self)
        return stat(path, &info) == 0 ? info.st_flags : nil
    }
    do {
        let encoded = try JSONEncoder().encode(flags)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("stat-flags: could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}

// MARK: - proc-info

struct ProcInfo: Codable {
    let pid: Int32
    let ppid: Int32
    let pgid: Int32
    let osStartTime: String
    let exeRealpath: String
    let args: [String]
}

func processStartIso(_ info: kinfo_proc) -> String {
    let seconds = TimeInterval(info.kp_proc.p_starttime.tv_sec)
    let micros = TimeInterval(info.kp_proc.p_starttime.tv_usec) / 1_000_000
    let date = Date(timeIntervalSince1970: seconds + micros)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
}

func kinfoForPid(_ pid: Int32) -> kinfo_proc? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    let rc = mib.withUnsafeMutableBufferPointer { ptr in
        sysctl(ptr.baseAddress, u_int(ptr.count), &info, &size, nil, 0)
    }
    return rc == 0 && size > 0 ? info : nil
}

func argsForPid(_ pid: Int32) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return [] }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, u_int(mib.count), &buffer, &size, nil, 0) == 0, size >= MemoryLayout<Int32>.size else { return [] }
    let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
    var offset = MemoryLayout<Int32>.size
    while offset < size && buffer[offset] != 0 { offset += 1 }
    while offset < size && buffer[offset] == 0 { offset += 1 }
    var args: [String] = []
    for _ in 0..<argc {
        if offset >= size { break }
        let start = offset
        while offset < size && buffer[offset] != 0 { offset += 1 }
        if offset > start {
            args.append(String(decoding: buffer[start..<offset], as: UTF8.self))
        }
        while offset < size && buffer[offset] == 0 { offset += 1 }
    }
    return args
}

func runProcInfo(pidText: String) -> Never {
    guard let pid = Int32(pidText), let info = kinfoForPid(pid) else { exit(0) }
    var pathBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    let pathLength = pathBuffer.withUnsafeMutableBufferPointer { buffer in
        proc_pidpath(pid, buffer.baseAddress, UInt32(buffer.count))
    }
    guard pathLength > 0 else { exit(0) }
    let exePath = String(cString: pathBuffer)
    let real = URL(fileURLWithPath: exePath).resolvingSymlinksInPath().path
    let result = ProcInfo(
        pid: pid,
        ppid: info.kp_eproc.e_ppid,
        pgid: getpgid(pid),
        osStartTime: processStartIso(info),
        exeRealpath: real,
        args: argsForPid(pid)
    )
    do {
        let encoded = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("proc-info: could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}

// MARK: - stall-watch

let stallPollSeconds: UInt32 = 5
let stallCooldownMs: UInt64 = 600_000
let sampleDeadlineMs: UInt64 = 60_000

/// Awake milliseconds. CLOCK_UPTIME_RAW stops while the Mac sleeps, so a lid-close never counts toward a
/// stall.
func awakeMs() -> UInt64 {
    clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1_000_000
}

/// The file's mtime in nanoseconds, or nil when stat(2) fails. Only ever compared for equality, so a
/// wall-clock step cannot fake a stall either.
func mtimeNs(_ path: String) -> Int? {
    var info = stat()
    guard stat(path, &info) == 0 else { return nil }
    return info.st_mtimespec.tv_sec * 1_000_000_000 + info.st_mtimespec.tv_nsec
}

/// Samples `pid` into `path` for 5 s at 10 ms; -mayDie keeps the symbols if `pid` dies mid-sample. True
/// only when sample exited 0 within the deadline; otherwise it is killed and its partial output removed,
/// so a failed sample never becomes a bundle.
func sampleInto(_ path: String, pid: Int32) -> Bool {
    let sampler = Process()
    sampler.executableURL = URL(fileURLWithPath: "/usr/bin/sample")
    sampler.arguments = [String(pid), "5", "10", "-mayDie", "-file", path]
    // This helper's stdout is the protocol pipe to the main process: sample must never write to it.
    sampler.standardOutput = FileHandle.nullDevice
    sampler.standardError = FileHandle.nullDevice
    do {
        try sampler.run()
    } catch {
        return false
    }
    let deadline = awakeMs() + sampleDeadlineMs
    while sampler.isRunning && awakeMs() < deadline {
        usleep(100_000)
    }
    if sampler.isRunning {
        kill(sampler.processIdentifier, SIGKILL)
        sampler.waitUntilExit()
    }
    let captured = sampler.terminationReason == .exit && sampler.terminationStatus == 0
    if !captured { unlink(path) }
    return captured
}

func runStallWatch(_ options: [String]) -> Never {
    func value(of flag: String) -> String? {
        guard let i = options.firstIndex(of: flag), i + 1 < options.count else { return nil }
        return options[i + 1]
    }
    guard let pid = value(of: "--pid").flatMap({ Int32($0) }),
          let alivePath = value(of: "--alive"),
          let capturePrefix = value(of: "--capture-prefix"),
          let staleAfterMs = value(of: "--stale-after-ms").flatMap({ UInt64($0) })
    else {
        fail("usage: metis-mac-helper stall-watch --pid <pid> --alive <file> --capture-prefix <path> --stale-after-ms <ms>")
    }
    guard getppid() == pid else { fail("stall-watch: --pid \(pid) is not this helper's parent") }

    // The poll wait is a kqueue wait on the parent, so main's death ends this helper at once instead of at the
    // next 5 s tick: a hard-killed app must leave no helper behind within the supervision bound.
    let kq = kqueue()
    if kq >= 0 {
        var parentEvent = kevent(
            ident: UInt(pid),
            filter: Int16(EVFILT_PROC),
            flags: UInt16(EV_ADD | EV_ENABLE),
            fflags: UInt32(NOTE_EXIT),
            data: 0,
            udata: nil
        )
        _ = kevent(kq, &parentEvent, 1, nil, 0, nil)
    }
    guard getppid() == pid else { exit(0) }

    var lastMtime = mtimeNs(alivePath)
    var lastChangeAt = awakeMs()
    var sampledThisStall = false
    var lastSampleAt: UInt64?
    while true {
        if kq >= 0 {
            var out = kevent()
            var timeout = timespec(tv_sec: Int(stallPollSeconds), tv_nsec: 0)
            if kevent(kq, nil, 0, &out, 1, &timeout) > 0 { exit(0) }
        } else {
            sleep(stallPollSeconds)
        }
        // A dead parent reparents this helper, so getppid() changes: exit rather than ever sample a
        // process this helper did not come from.
        guard getppid() == pid else { exit(0) }
        let now = awakeMs()
        let mtime = mtimeNs(alivePath)
        // An unreadable marker is no evidence of a stall: treat it like a fresh write.
        if mtime == nil || mtime != lastMtime {
            lastMtime = mtime
            lastChangeAt = now
            sampledThisStall = false
            continue
        }
        let stalledMs = now - lastChangeAt
        let cooledDown = lastSampleAt.map { now - $0 >= stallCooldownMs } ?? true
        guard stalledMs > staleAfterMs, !sampledThisStall, cooledDown else { continue }
        sampledThisStall = true
        lastSampleAt = now
        let epochMs = Int64(Date().timeIntervalSince1970 * 1000)
        let captured = sampleInto("\(capturePrefix).\(epochMs).\(stalledMs).sample", pid: pid)
        print(captured ? "sampled" : "failed")
        fflush(stdout)
    }
}

// MARK: - supervise

private var supervisedChildPid: pid_t = -1
private var forwardedSignal: Int32 = 0

func signalForwarder(_ signal: Int32) {
    forwardedSignal = signal
    if supervisedChildPid > 0 {
        kill(supervisedChildPid, signal)
    }
}

// Xcode 26's SDK marks WIFEXITED/WIFSIGNALED/WTERMSIG/WEXITSTATUS as function-like C macros,
// which Swift cannot import. Reimplement them over the raw wait(2) status word.
private func waitTermSig(_ status: Int32) -> Int32 { status & 0x7f }
private func waitExited(_ status: Int32) -> Bool { waitTermSig(status) == 0 }
private func waitSignaled(_ status: Int32) -> Bool {
    let termsig = waitTermSig(status)
    return termsig != 0 && termsig != 0x7f
}
private func waitExitStatus(_ status: Int32) -> Int32 { (status >> 8) & 0xff }

func exitWithChildStatus(_ status: Int32) -> Never {
    if waitExited(status) {
        exit(waitExitStatus(status))
    }
    if waitSignaled(status) {
        let termsig = waitTermSig(status)
        signal(SIGTERM, SIG_DFL)
        signal(termsig, SIG_DFL)
        raise(termsig)
        exit(128 + termsig)
    }
    exit(1)
}

// Exit status of a supervise setup failure (bad arguments, setpgid, kqueue, spawn). The supervised child was
// never started, so the caller may spawn it directly. Any other status is the child's own or a later abort.
let superviseSetupFailureStatus: Int32 = 125

func superviseSetupFailure(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(superviseSetupFailureStatus)
}

// TERM the group, wait up to 2 s for the direct child, then SIGKILL the whole group unconditionally so
// grandchildren that ignore TERM die too. The helper leads the group, so the final SIGKILL ends it as well:
// callers write any diagnostic before calling.
func terminateSupervisedGroup() {
    guard supervisedChildPid > 0 else { return }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    killpg(getpgrp(), SIGTERM)
    let deadline = Date().addingTimeInterval(2)
    var status: Int32 = 0
    while Date() < deadline {
        let waited = waitpid(supervisedChildPid, &status, WNOHANG)
        if waited == supervisedChildPid {
            supervisedChildPid = -1
            break
        }
        usleep(50_000)
    }
    killpg(getpgrp(), SIGKILL)
}

func abortSupervise(_ message: String? = nil) -> Never {
    if let message { FileHandle.standardError.write((message + "\n").data(using: .utf8)!) }
    terminateSupervisedGroup()
    exit(1)
}

func runSupervise(_ options: [String]) -> Never {
    guard options.count >= 4, options[0] == "--parent", let parent = pid_t(options[1]), options[2] == "--" else {
        superviseSetupFailure("usage: metis-mac-helper supervise --parent <pid> -- <cmd> [args...]")
    }
    let command = options[3]
    let childArgs = Array(options.dropFirst(3))
    guard getppid() == parent else {
        superviseSetupFailure("supervise: --parent \(parent) is not this helper's parent")
    }
    guard setpgid(0, 0) == 0 else {
        superviseSetupFailure("supervise: setpgid failed: \(String(cString: strerror(errno)))")
    }

    let kq = kqueue()
    guard kq >= 0 else { superviseSetupFailure("supervise: kqueue failed: \(String(cString: strerror(errno)))") }
    var parentEvent = kevent(
        ident: UInt(parent),
        filter: Int16(EVFILT_PROC),
        flags: UInt16(EV_ADD | EV_ENABLE),
        fflags: UInt32(NOTE_EXIT),
        data: 0,
        udata: nil
    )
    guard kevent(kq, &parentEvent, 1, nil, 0, nil) == 0 else {
        superviseSetupFailure("supervise: parent watch failed: \(String(cString: strerror(errno)))")
    }
    guard getppid() == parent else { superviseSetupFailure("supervise: parent exited before the watch was armed") }

    let argv = childArgs.map { strdup($0) } + [nil]
    defer {
        for arg in argv where arg != nil { free(arg) }
    }
    var child: pid_t = 0
    let spawnResult = command.withCString { commandC in
        argv.withUnsafeBufferPointer { buffer in
            posix_spawn(&child, commandC, nil, nil, UnsafeMutablePointer(mutating: buffer.baseAddress!), environ)
        }
    }
    guard spawnResult == 0 else {
        superviseSetupFailure("supervise: spawn failed: \(String(cString: strerror(spawnResult)))")
    }
    supervisedChildPid = child
    signal(SIGTERM, signalForwarder)
    signal(SIGINT, signalForwarder)

    var status: Int32 = 0
    while true {
        let waited = waitpid(child, &status, WNOHANG)
        if waited == child {
            supervisedChildPid = -1
            exitWithChildStatus(status)
        }
        if waited < 0 && errno != EINTR {
            abortSupervise("supervise: waitpid failed: \(String(cString: strerror(errno)))")
        }
        if getppid() != parent {
            abortSupervise()
        }
        var out = kevent()
        var timeout = timespec(tv_sec: 0, tv_nsec: 50_000_000)
        let events = kevent(kq, nil, 0, &out, 1, &timeout)
        if events > 0 {
            abortSupervise()
        }
        if events < 0 && errno != EINTR {
            abortSupervise("supervise: parent watch read failed: \(String(cString: strerror(errno)))")
        }
        if forwardedSignal != 0 {
            usleep(50_000)
        }
    }
}

// MARK: - code-identity / bundle-copies

struct CodeIdentityResult: Encodable {
    let identifier: String
    let cdhash: String
    let teamId: String
    let adhoc: Bool
}

struct BundleCopy: Encodable {
    let path: String
    let version: String
}

struct BundleCopiesResult: Encodable {
    let copies: [BundleCopy]
}

func emitJson<T: Encodable>(_ value: T, command: String) -> Never {
    do {
        let encoded = try JSONEncoder().encode(value)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("\(command): could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}

func runCodeIdentity(path: String) -> Never {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &staticCode) == errSecSuccess,
          let code = staticCode else {
        fail("code-identity: cannot read code at \(path)")
    }
    var infoRef: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoRef) == errSecSuccess,
          let info = infoRef as? [String: Any] else {
        fail("code-identity: no signing information for \(path)")
    }
    let cdhash = (info[kSecCodeInfoUnique as String] as? Data)?.map { String(format: "%02x", $0) }.joined() ?? ""
    let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    emitJson(CodeIdentityResult(
        identifier: info[kSecCodeInfoIdentifier as String] as? String ?? "",
        cdhash: cdhash,
        teamId: info[kSecCodeInfoTeamIdentifier as String] as? String ?? "",
        adhoc: SecCodeSignatureFlags(rawValue: flags).contains(.adhoc)
    ), command: "code-identity")
}

func runBundleCopies(bundleId: String) -> Never {
    let copies = NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleId).map { url in
        BundleCopy(
            path: url.path,
            version: Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        )
    }
    emitJson(BundleCopiesResult(copies: copies), command: "bundle-copies")
}

struct TccStatusResult: Encodable {
    let status: String
}

func runTccStatus(_ options: [String]) -> Never {
    guard let probe = options.first else {
        fail("usage: metis-mac-helper tcc-status <listen-event|automation> [bundle-id]")
    }
    switch probe {
    case "listen-event":
        // Read-only: CGRequestListenEventAccess is the prompting call and is deliberately never used.
        emitJson(TccStatusResult(status: CGPreflightListenEventAccess() ? "granted" : "denied"), command: "tcc-status")
    case "automation":
        guard options.count >= 2 else {
            fail("usage: metis-mac-helper tcc-status automation <bundle-id>")
        }
        let target = NSAppleEventDescriptor(bundleIdentifier: options[1])
        guard let desc = target.aeDesc else {
            fail("tcc-status: cannot address \(options[1])")
        }
        let result = AEDeterminePermissionToAutomateTarget(desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
        switch result {
        case noErr:
            emitJson(TccStatusResult(status: "granted"), command: "tcc-status")
        case OSStatus(errAEEventNotPermitted):
            emitJson(TccStatusResult(status: "denied"), command: "tcc-status")
        default:
            // errAEEventWouldRequireUserConsent (not asked yet), procNotFound (target not running), anything else.
            emitJson(TccStatusResult(status: "unknown"), command: "tcc-status")
        }
    default:
        fail("tcc-status: unknown probe \(probe)")
    }
}

func runAutomationAsk(bundleId: String) -> Never {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundleId)
    guard let desc = target.aeDesc else {
        fail("automation-ask: cannot address \(bundleId)")
    }
    let result = AEDeterminePermissionToAutomateTarget(desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), true)
    switch result {
    case noErr:
        emitJson(TccStatusResult(status: "granted"), command: "automation-ask")
    case OSStatus(errAEEventNotPermitted):
        emitJson(TccStatusResult(status: "denied"), command: "automation-ask")
    default:
        // procNotFound (target not running) and anything else: the person was not asked, so the answer is unknown.
        emitJson(TccStatusResult(status: "unknown"), command: "automation-ask")
    }
}

struct ActivatePidResult: Encodable {
    let activated: Bool
}

func runActivatePid(pidText: String) -> Never {
    guard let pid = pid_t(pidText), pid > 0, let app = NSRunningApplication(processIdentifier: pid) else {
        fail("activate-pid: no running application for \(pidText)")
    }
    func waitUntilActive(_ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !app.isActive && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return app.isActive
    }
    _ = app.activate(options: [.activateAllWindows])
    var activated = waitUntilActive(0.15)
    if !activated, let url = app.bundleURL {
        // macOS 14 and later only honours a direct activation from the frontmost app. Ask LaunchServices instead.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
        activated = waitUntilActive(1.2)
    }
    emitJson(ActivatePidResult(activated: activated), command: "activate-pid")
}

// MARK: - speak

let maxSpeakChars = 8000

func emitSpeakLine(_ line: String) {
    print(line)
    fflush(stdout)
}

final class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onStart: () -> Void = {}
    var onFinish: () -> Void = {}
    var onCancel: () -> Void = {}
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) { onStart() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { onFinish() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { onCancel() }
}

func runSpeak(_ options: [String]) -> Never {
    let usage = "usage: metis-mac-helper speak --voice <id> [--rate <0.5-1.5>]"
    var voiceId: String?
    var rate: Float = 1.0
    var index = 0
    while index < options.count {
        guard index + 1 < options.count else { fail(usage) }
        switch options[index] {
        case "--voice":
            voiceId = options[index + 1]
        case "--rate":
            guard let value = Float(options[index + 1]), value.isFinite else { fail(usage) }
            rate = min(1.5, max(0.5, value))
        default:
            fail(usage)
        }
        index += 2
    }

    let parent = getppid()
    let parentWatch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
    parentWatch.setEventHandler { exit(0) }
    parentWatch.resume()
    if getppid() != parent { exit(0) }

    let data = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(String(decoding: data, as: UTF8.self).prefix(maxSpeakChars))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
        emitSpeakLine("ended")
        exit(0)
    }

    let utterance = AVSpeechUtterance(string: text)
    guard let id = voiceId, let voice = AVSpeechSynthesisVoice(identifier: id) else {
        emitSpeakLine("error no_voice")
        exit(2)
    }
    utterance.voice = voice
    utterance.rate = min(
        AVSpeechUtteranceMaximumSpeechRate,
        max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate)
    )

    let synthesizer = AVSpeechSynthesizer()
    let delegate = SpeakDelegate()
    delegate.onStart = { emitSpeakLine("started") }
    delegate.onFinish = {
        emitSpeakLine("ended")
        exit(0)
    }
    delegate.onCancel = {
        emitSpeakLine("cancelled")
        exit(0)
    }
    synthesizer.delegate = delegate

    signal(SIGTERM, SIG_IGN)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminate.setEventHandler {
        synthesizer.stopSpeaking(at: .immediate)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150)) {
            emitSpeakLine("cancelled")
            exit(0)
        }
    }
    terminate.resume()

    synthesizer.speak(utterance)
    withExtendedLifetime(parentWatch) {
        withExtendedLifetime(terminate) {
            withExtendedLifetime(synthesizer) {
                withExtendedLifetime(delegate) { RunLoop.main.run() }
            }
        }
    }
    exit(0)
}

struct SpeakVoice: Encodable {
    let id: String
    let name: String
    let language: String
}

struct SpeakVoicesResult: Encodable {
    let voices: [SpeakVoice]
}

func runSpeakVoices() -> Never {
    let voices = AVSpeechSynthesisVoice.speechVoices().map {
        SpeakVoice(id: $0.identifier, name: $0.name, language: $0.language)
    }
    emitJson(SpeakVoicesResult(voices: voices), command: "speak-voices")
}

// MARK: - ax-focus-snapshot / ax-insert (G23, dictation insertion)

/// Applications that are terminals whatever their elements say. Anything else is classified from its element.
let axTerminalBundleIds: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "net.kovidgoyal.kitty", "com.github.wez.wezterm",
    "io.alacritty", "org.alacritty", "dev.warp.Warp-Stable", "dev.warp.Warp", "com.mitchellh.ghostty",
    "co.zeit.hyper", "org.tabby", "com.raphaelamorim.rio", "com.cmuxterm.app", "net.sourceforge.iTerm"
]
let axMaxValueUnits = 4_000_000
let axMaxInsertUnits = 32_768
let axMaxClipboardBytes = 16 * 1_024 * 1_024

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func sha256Hex(_ text: String) -> String {
    sha256Hex(Data(text.utf8))
}

struct AxSnapshot {
    let element: AXUIElement
    let pid: pid_t
    let bundleId: String
    let processStartMs: Int64
    let windowId: String
    let role: String
    let subrole: String
    let token: String
    let secure: Bool
    let editable: Bool
    let terminal: Bool
    /// Never set for a secure field: the value of one is not read.
    let value: String?
    let valueTooLarge: Bool
    let selection: CFRange?
}

enum AxResolution {
    case permission
    case noFocus
    case secure(AxSnapshot)
    case found(AxSnapshot)
}

func axCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

func axText(_ element: AXUIElement, _ attribute: String) -> String {
    (axCopy(element, attribute) as? String) ?? ""
}

func axRange(_ element: AXUIElement) -> CFRange? {
    guard let raw = axCopy(element, kAXSelectedTextRangeAttribute as String),
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(raw as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
    return range
}

func axSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
}

/// Looks at the frontmost application's focused element. Read-only; Accessibility trust is checked without a prompt.
func resolveFocusedElement() -> AxResolution {
    guard AXIsProcessTrusted() else { return .permission }
    guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier > 0 else { return .noFocus }
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    guard let raw = axCopy(appElement, kAXFocusedUIElementAttribute as String),
          CFGetTypeID(raw) == AXUIElementGetTypeID() else { return .noFocus }
    let element = raw as! AXUIElement
    var owner: pid_t = 0
    guard AXUIElementGetPid(element, &owner) == .success, owner == app.processIdentifier else { return .noFocus }

    let bundleId = app.bundleIdentifier ?? "pid-\(app.processIdentifier)"
    let role = axText(element, kAXRoleAttribute as String)
    let subrole = axText(element, kAXSubroleAttribute as String)
    let roleDescription = axText(element, kAXRoleDescriptionAttribute as String).lowercased()
    let description = axText(element, kAXDescriptionAttribute as String).lowercased()
    // Secure: a secure text field, or the system says secure keyboard input is on (a password prompt anywhere).
    let secure = subrole == (kAXSecureTextFieldSubrole as String)
        || subrole.localizedCaseInsensitiveContains("secure")
        || roleDescription.contains("secure")
        || IsSecureEventInputEnabled()
    let terminal = axTerminalBundleIds.contains(bundleId)
        || description.contains("terminal") || roleDescription.contains("terminal") || description == "shell"

    var windowHash = "none"
    if let windowRaw = axCopy(element, kAXWindowAttribute as String), CFGetTypeID(windowRaw) == AXUIElementGetTypeID() {
        windowHash = String(CFHash(windowRaw))
    }
    let windowId = "w" + String(sha256Hex("\(owner)|\(windowHash)").prefix(16))
    let token = String(sha256Hex("\(owner)|\(windowHash)|\(role)|\(subrole)|\(CFHash(element))").prefix(32))
    let textRole = role == (kAXTextFieldRole as String) || role == (kAXTextAreaRole as String)
        || role == (kAXComboBoxRole as String)
    let editable = textRole && axSettable(element, kAXValueAttribute as String) || terminal && textRole

    var value: String?
    var tooLarge = false
    var selection: CFRange?
    if !secure {
        if let text = axCopy(element, kAXValueAttribute as String) as? String {
            if text.utf16.count > axMaxValueUnits { tooLarge = true } else { value = text }
        }
        selection = axRange(element)
    }
    let launch = app.launchDate.map { Int64($0.timeIntervalSince1970 * 1000) } ?? 0
    let snapshot = AxSnapshot(
        element: element, pid: owner, bundleId: bundleId, processStartMs: launch, windowId: windowId,
        role: role, subrole: subrole, token: token, secure: secure, editable: editable, terminal: terminal,
        value: value, valueTooLarge: tooLarge, selection: selection
    )
    return secure ? .secure(snapshot) : .found(snapshot)
}

struct AxSelectionOut: Encodable {
    let location: Int
    let length: Int
}

struct AxSnapshotResult: Encodable {
    /// ok | permission | no_focus
    let status: String
    let pid: Int32?
    let bundleId: String?
    let processStartMs: Int64?
    let windowId: String?
    let role: String?
    let subrole: String?
    let token: String?
    let secure: Bool
    let editable: Bool
    let terminal: Bool
    let valueHash: String?
    let valueLength: Int?
    let valueTooLarge: Bool
    let selection: AxSelectionOut?
}

func axSnapshotResult(_ resolution: AxResolution) -> AxSnapshotResult {
    func empty(_ status: String) -> AxSnapshotResult {
        AxSnapshotResult(status: status, pid: nil, bundleId: nil, processStartMs: nil, windowId: nil, role: nil,
                         subrole: nil, token: nil, secure: false, editable: false, terminal: false, valueHash: nil,
                         valueLength: nil, valueTooLarge: false, selection: nil)
    }
    switch resolution {
    case .permission: return empty("permission")
    case .noFocus: return empty("no_focus")
    case .secure(let s), .found(let s):
        return AxSnapshotResult(
            status: "ok", pid: s.pid, bundleId: s.bundleId, processStartMs: s.processStartMs, windowId: s.windowId,
            role: s.role, subrole: s.subrole, token: s.token, secure: s.secure, editable: s.editable,
            terminal: s.terminal, valueHash: s.value.map { sha256Hex($0) }, valueLength: s.value?.utf16.count,
            valueTooLarge: s.valueTooLarge,
            selection: s.selection.map { AxSelectionOut(location: $0.location, length: $0.length) }
        )
    }
}

func runAxFocusSnapshot() -> Never {
    emitJson(axSnapshotResult(resolveFocusedElement()), command: "ax-focus-snapshot")
}

/// The terminal sink: a dictation can never run a command. Control characters (newline, return, tab, escape, the
/// C1 range, DEL), line and paragraph separators and bidi overrides become a space (line breaks) or are dropped,
/// then trailing blanks are trimmed, so no Return can be sent.
func terminalSafe(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in text.unicodeScalars {
        let v = scalar.value
        switch v {
        case 0x0A, 0x0D, 0x09, 0x0B, 0x0C, 0x85, 0x2028, 0x2029:
            out.append(" ")
        case 0x00...0x1F, 0x7F...0x9F, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069:
            continue
        default:
            out.append(scalar)
        }
    }
    var result = String(out)
    while let last = result.last, last == " " { result.removeLast() }
    return result
}

struct AxInsertRequest: Decodable {
    let pid: Int32
    let windowId: String
    let token: String
    let valueHash: String
    let valueLength: Int
    let selectionLocation: Int
    let selectionLength: Int
    let text: String
    let allowPaste: Bool
}

struct AxInsertResult: Encodable {
    /// verified | unverified | refused | unsupported
    let outcome: String
    /// secure_field | target_changed | permission | unsupported | invalid_request
    let reason: String?
    /// ax | paste | none
    let method: String
    let terminal: Bool
    /// The text was changed by the terminal sink before it was written.
    let sanitized: Bool
    let textHash: String?
    let textLength: Int
    /// not_used | restored | kept_newer | left_unrestored
    let clipboard: String
}

func axInsertResult(
    _ outcome: String, reason: String? = nil, method: String = "none", terminal: Bool = false,
    sanitized: Bool = false, text: String = "", clipboard: String = "not_used"
) -> AxInsertResult {
    AxInsertResult(
        outcome: outcome, reason: reason, method: method, terminal: terminal, sanitized: sanitized,
        textHash: text.isEmpty ? nil : sha256Hex(text), textLength: text.utf16.count, clipboard: clipboard
    )
}

/// The value after replacing the range [location, location+length) of `value` (UTF-16 units) with `text`.
func axExpectedValue(_ value: String, location: Int, length: Int, text: String) -> String? {
    let units = Array(value.utf16)
    guard location >= 0, length >= 0, location + length <= units.count else { return nil }
    let merged = Array(units[0..<location]) + Array(text.utf16) + Array(units[(location + length)...])
    return String(utf16CodeUnits: merged, count: merged.count)
}

/// Polls the element's value until it hashes to `expected` or the time is up.
func axWaitForValue(_ element: AXUIElement, expectedHash: String, seconds: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        if let now = axCopy(element, kAXValueAttribute as String) as? String, sha256Hex(now) == expectedHash { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    } while Date() < deadline
    return false
}

struct SavedPasteboard {
    let items: [[(NSPasteboard.PasteboardType, Data)]]
}

func savePasteboard(_ pasteboard: NSPasteboard) -> SavedPasteboard? {
    var total = 0
    var items: [[(NSPasteboard.PasteboardType, Data)]] = []
    for item in pasteboard.pasteboardItems ?? [] {
        var entries: [(NSPasteboard.PasteboardType, Data)] = []
        for type in item.types {
            guard let data = item.data(forType: type) else { continue }
            total += data.count
            if total > axMaxClipboardBytes { return nil }
            entries.append((type, data))
        }
        items.append(entries)
    }
    return SavedPasteboard(items: items)
}

func restorePasteboard(_ pasteboard: NSPasteboard, _ saved: SavedPasteboard) {
    pasteboard.clearContents()
    let restored = saved.items.map { entries -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in entries { item.setData(data, forType: type) }
        return item
    }
    if !restored.isEmpty { pasteboard.writeObjects(restored) }
}

func axSameTarget(_ snapshot: AxSnapshot, _ request: AxInsertRequest) -> Bool {
    snapshot.pid == request.pid && snapshot.windowId == request.windowId && snapshot.token == request.token
}

func runAxInsert() -> Never {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try? JSONDecoder().decode(AxInsertRequest.self, from: input),
          request.pid > 0, request.selectionLocation >= 0, request.selectionLength >= 0, !request.text.isEmpty,
          request.text.utf16.count <= axMaxInsertUnits else {
        emitJson(axInsertResult("refused", reason: "invalid_request"), command: "ax-insert")
    }
    // 1. Look again, right now. Secure and permission win over everything else.
    let snapshot: AxSnapshot
    switch resolveFocusedElement() {
    case .permission: emitJson(axInsertResult("refused", reason: "permission"), command: "ax-insert")
    case .noFocus: emitJson(axInsertResult("refused", reason: "target_changed"), command: "ax-insert")
    case .secure: emitJson(axInsertResult("refused", reason: "secure_field"), command: "ax-insert")
    case .found(let found): snapshot = found
    }
    // 2. Compare: process, window, element and the exact value and selection the guard bound.
    guard axSameTarget(snapshot, request), let before = snapshot.value, sha256Hex(before) == request.valueHash,
          before.utf16.count == request.valueLength, let selection = snapshot.selection,
          selection.location == request.selectionLocation, selection.length == request.selectionLength else {
        emitJson(axInsertResult("refused", reason: "target_changed", terminal: snapshot.terminal), command: "ax-insert")
    }
    guard snapshot.editable else {
        emitJson(axInsertResult("unsupported", reason: "unsupported", terminal: snapshot.terminal), command: "ax-insert")
    }
    let terminal = snapshot.terminal
    let text = terminal ? terminalSafe(request.text) : request.text
    let sanitized = text != request.text
    guard !text.isEmpty else {
        emitJson(axInsertResult("refused", reason: "invalid_request", terminal: terminal, sanitized: sanitized), command: "ax-insert")
    }
    guard let expected = axExpectedValue(before, location: selection.location, length: selection.length, text: text) else {
        emitJson(axInsertResult("refused", reason: "target_changed", terminal: terminal), command: "ax-insert")
    }
    let expectedHash = sha256Hex(expected)

    // 3. AX insertion by selected-text replacement. Terminals never take this path: their text area is the
    //    scrollback, not the shell, so only a paste reaches the command line.
    if !terminal, axSettable(snapshot.element, kAXSelectedTextAttribute as String) {
        let status = AXUIElementSetAttributeValue(snapshot.element, kAXSelectedTextAttribute as CFString, text as CFString)
        if status == .success {
            let verified = axWaitForValue(snapshot.element, expectedHash: expectedHash, seconds: 0.5)
            // A success the field does not show is NOT retried by paste: it may still apply late.
            emitJson(axInsertResult(verified ? "verified" : "unverified", method: "ax", sanitized: sanitized, text: text),
                     command: "ax-insert")
        }
        // Any other status means nothing was written: only then may the paste fallback run.
    }
    guard request.allowPaste else {
        emitJson(axInsertResult("unsupported", reason: "unsupported", terminal: terminal), command: "ax-insert")
    }

    // 4. Paste fallback with a clipboard ownership token.
    let pasteboard = NSPasteboard.general
    guard let saved = savePasteboard(pasteboard) else {
        emitJson(axInsertResult("unsupported", reason: "unsupported", terminal: terminal), command: "ax-insert")
    }
    // The front application and the field must still be the same one at the moment of the paste.
    switch resolveFocusedElement() {
    case .found(let again) where axSameTarget(again, request) && again.value.map({ sha256Hex($0) }) == request.valueHash:
        break
    case .permission:
        emitJson(axInsertResult("refused", reason: "permission", terminal: terminal), command: "ax-insert")
    case .secure:
        emitJson(axInsertResult("refused", reason: "secure_field", terminal: terminal), command: "ax-insert")
    default:
        emitJson(axInsertResult("refused", reason: "target_changed", terminal: terminal), command: "ax-insert")
    }
    let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    let token = pasteboard.declareTypes([.string, concealed, transient], owner: nil)
    let wrote = pasteboard.setString(text, forType: .string)
        && pasteboard.setData(Data(), forType: concealed) && pasteboard.setData(Data(), forType: transient)
    guard wrote, pasteboard.changeCount == token else {
        // Someone else wrote in between: nothing of ours is left to take back, and nothing was pasted.
        emitJson(axInsertResult("refused", reason: "target_changed", terminal: terminal), command: "ax-insert")
    }
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
        if pasteboard.changeCount == token { restorePasteboard(pasteboard, saved) }
        emitJson(axInsertResult("unsupported", reason: "unsupported", terminal: terminal), command: "ax-insert")
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.postToPid(request.pid)
    up.postToPid(request.pid)
    let verified = terminal ? false : axWaitForValue(snapshot.element, expectedHash: expectedHash, seconds: 0.6)
    if terminal { RunLoop.current.run(until: Date().addingTimeInterval(0.4)) }
    // Restore only while the clipboard is still exactly what this helper wrote. A newer copy is never touched.
    var clipboard = "kept_newer"
    if pasteboard.changeCount == token {
        restorePasteboard(pasteboard, saved)
        clipboard = "restored"
    }
    emitJson(axInsertResult(verified ? "verified" : "unverified", method: "paste", terminal: terminal,
                            sanitized: sanitized, text: text, clipboard: clipboard), command: "ax-insert")
}

// MARK: - entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: metis-mac-helper <watch-frontmost|ocr|transcribe|screen-metrics|stat-flags|proc-info|supervise|stall-watch|code-identity|bundle-copies|tcc-status|automation-ask|activate-pid|ax-focus-snapshot|ax-insert|watch-modifiers|speak|speak-voices> [path|-]")
}
switch arguments[1] {
case "watch-frontmost":
    watchFrontmost()
case "watch-modifiers":
    watchModifiers(Array(arguments.dropFirst(2)))
case "ocr":
    runOcr(inputPath: arguments.count >= 3 ? arguments[2] : "-")
case "transcribe":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper transcribe <wav-path> [locale]")
    }
    runTranscribe(path: arguments[2], localeIdentifier: arguments.count >= 4 ? arguments[3] : nil)
case "screen-metrics":
    runScreenMetrics()
case "stat-flags":
    runStatFlags()
case "proc-info":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper proc-info <pid>")
    }
    runProcInfo(pidText: arguments[2])
case "supervise":
    runSupervise(Array(arguments.dropFirst(2)))
case "stall-watch":
    runStallWatch(Array(arguments.dropFirst(2)))
case "code-identity":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper code-identity <path>")
    }
    runCodeIdentity(path: arguments[2])
case "bundle-copies":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper bundle-copies <bundle-id>")
    }
    runBundleCopies(bundleId: arguments[2])
case "tcc-status":
    runTccStatus(Array(arguments.dropFirst(2)))
case "speak":
    runSpeak(Array(arguments.dropFirst(2)))
case "speak-voices":
    runSpeakVoices()
case "automation-ask":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper automation-ask <bundle-id>")
    }
    runAutomationAsk(bundleId: arguments[2])
case "activate-pid":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper activate-pid <pid>")
    }
    runActivatePid(pidText: arguments[2])
case "ax-focus-snapshot":
    runAxFocusSnapshot()
case "ax-insert":
    runAxInsert()
default:
    fail("unknown command: \(arguments[1])")
}
