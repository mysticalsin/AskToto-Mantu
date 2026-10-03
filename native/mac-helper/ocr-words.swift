import CoreGraphics
import Foundation
import ImageIO
import Vision

private struct OcrWordsBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct OcrWordsLine: Codable {
    let id: String
    let text: String
    let confidence: Double?
    let box: OcrWordsBox
}

private struct OcrWordsWord: Codable {
    let text: String
    let confidence: Double?
    let box: OcrWordsBox
    let lineId: String
}

private struct OcrWordsImage: Codable {
    let width: Int
    let height: Int
}

private struct OcrWordsTruncated: Codable {
    let lines: Bool
    let words: Bool
}

private struct OcrWordsResult: Codable {
    let image: OcrWordsImage
    let coverage: String
    let untrustedContent: Bool
    let truncated: OcrWordsTruncated
    let lines: [OcrWordsLine]
    let words: [OcrWordsWord]
}

private let ocrWordsMaxLines = 200
private let ocrWordsMaxWords = 2_000
private let ocrWordsRowTolerance = 0.025

private func topLeftBox(_ box: CGRect) -> OcrWordsBox {
    let x0 = max(0, min(1, box.origin.x))
    let y0 = max(0, min(1, 1 - box.origin.y - box.size.height))
    let x1 = max(0, min(1, box.origin.x + box.size.width))
    let y1 = max(0, min(1, 1 - box.origin.y))
    OcrWordsBox(
        x: x0,
        y: y0,
        width: max(0, x1 - x0),
        height: max(0, y1 - y0)
    )
}

private func wordRanges(in text: String) -> [(String, Range<String.Index>)] {
    var ranges: [(String, Range<String.Index>)] = []
    var start: String.Index?
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(after: index)
        if text[index].isWhitespace {
            if let s = start {
                ranges.append((String(text[s..<index]), s..<index))
                start = nil
            }
        } else if start == nil {
            start = index
        }
        index = next
    }
    if let s = start {
        ranges.append((String(text[s..<text.endIndex]), s..<text.endIndex))
    }
    return ranges
}

private func readingOrdered<T>(_ values: [T], box: (T) -> OcrWordsBox) -> [T] {
    values.sorted { left, right in
        let a = box(left)
        let b = box(right)
        if abs(a.y - b.y) > ocrWordsRowTolerance { return a.y < b.y }
        return a.x < b.x
    }
}

func runOcrWords(inputPath: String) -> Never {
    let data: Data
    if inputPath == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        guard let fileData = FileManager.default.contents(atPath: inputPath) else {
            fail("ocr-words: could not read \(inputPath)")
        }
        data = fileData
    }
    guard !data.isEmpty,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("ocr-words: input is not a decodable image")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US", "fr-FR"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("ocr-words: \(error.localizedDescription)")
    }

    var lines: [OcrWordsLine] = []
    var words: [OcrWordsWord] = []
    for (lineIndex, observation) in (request.results ?? []).enumerated() {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let lineId = "line-\(lineIndex + 1)"
        let lineBox = topLeftBox(observation.boundingBox)
        lines.append(OcrWordsLine(
            id: lineId,
            text: candidate.string,
            confidence: Double(candidate.confidence),
            box: lineBox
        ))
        for (text, range) in wordRanges(in: candidate.string) {
            if let wordBox = try? candidate.boundingBox(for: range) {
                words.append(OcrWordsWord(
                    text: text,
                    confidence: nil,
                    box: topLeftBox(wordBox.boundingBox),
                    lineId: lineId
                ))
            }
        }
    }

    let orderedLines = readingOrdered(lines) { $0.box }
    let keptLines = Array(orderedLines.prefix(ocrWordsMaxLines))
    let keptLineIds = Set(keptLines.map { $0.id })
    let lineFilteredWords = words.filter { keptLineIds.contains($0.lineId) }
    let orderedWords = readingOrdered(lineFilteredWords) { $0.box }
    let droppedWordsForRemovedLines = lineFilteredWords.count != words.count
    let result = OcrWordsResult(
        image: OcrWordsImage(width: image.width, height: image.height),
        coverage: "VISIBLE_ONLY",
        untrustedContent: true,
        truncated: OcrWordsTruncated(
            lines: orderedLines.count > ocrWordsMaxLines,
            words: droppedWordsForRemovedLines || orderedWords.count > ocrWordsMaxWords
        ),
        lines: keptLines,
        words: Array(orderedWords.prefix(ocrWordsMaxWords))
    )
    do {
        let encoded = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("ocr-words: could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}
