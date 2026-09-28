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
import AppKit
import Darwin
import Speech
import Vision

@_silgen_name("environ")
var processEnvironment: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>!

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

    var lastMtime = mtimeNs(alivePath)
    var lastChangeAt = awakeMs()
    var sampledThisStall = false
    var lastSampleAt: UInt64?
    while true {
        sleep(stallPollSeconds)
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
            return
        }
        usleep(50_000)
    }
    killpg(getpgrp(), SIGKILL)
}

func runSupervise(_ options: [String]) -> Never {
    guard options.count >= 4, options[0] == "--parent", let parent = pid_t(options[1]), options[2] == "--" else {
        fail("usage: metis-mac-helper supervise --parent <pid> -- <cmd> [args...]")
    }
    let command = options[3]
    let childArgs = Array(options.dropFirst(3))
    guard getppid() == parent else { fail("supervise: --parent \(parent) is not this helper's parent") }
    guard setpgid(0, 0) == 0 else { fail("supervise: setpgid failed: \(String(cString: strerror(errno)))") }

    let kq = kqueue()
    guard kq >= 0 else { fail("supervise: kqueue failed: \(String(cString: strerror(errno)))") }
    var parentEvent = kevent(
        ident: UInt(parent),
        filter: Int16(EVFILT_PROC),
        flags: UInt16(EV_ADD | EV_ENABLE),
        fflags: UInt32(NOTE_EXIT),
        data: 0,
        udata: nil
    )
    guard kevent(kq, &parentEvent, 1, nil, 0, nil) == 0 else {
        fail("supervise: parent watch failed: \(String(cString: strerror(errno)))")
    }
    guard getppid() == parent else {
        terminateSupervisedGroup()
        exit(1)
    }

    let argv = childArgs.map { strdup($0) } + [nil]
    defer {
        for arg in argv where arg != nil { free(arg) }
    }
    var child: pid_t = 0
    let spawnResult = command.withCString { commandC in
        argv.withUnsafeBufferPointer { buffer in
            posix_spawn(&child, commandC, nil, nil, UnsafeMutablePointer(mutating: buffer.baseAddress!), processEnvironment)
        }
    }
    guard spawnResult == 0 else {
        fail("supervise: spawn failed: \(String(cString: strerror(spawnResult)))")
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
            terminateSupervisedGroup()
            fail("supervise: waitpid failed: \(String(cString: strerror(errno)))")
        }
        if getppid() != parent {
            terminateSupervisedGroup()
            exit(1)
        }
        var out = kevent()
        var timeout = timespec(tv_sec: 0, tv_nsec: 50_000_000)
        let events = kevent(kq, nil, 0, &out, 1, &timeout)
        if events > 0 {
            terminateSupervisedGroup()
            exit(1)
        }
        if events < 0 && errno != EINTR {
            terminateSupervisedGroup()
            fail("supervise: parent watch read failed: \(String(cString: strerror(errno)))")
        }
        if forwardedSignal != 0 {
            usleep(50_000)
        }
    }
}

// MARK: - entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: metis-mac-helper <watch-frontmost|ocr|transcribe|screen-metrics|stat-flags|proc-info|supervise|stall-watch> [path|-]")
}
switch arguments[1] {
case "watch-frontmost":
    watchFrontmost()
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
default:
    fail("unknown command: \(arguments[1])")
}
