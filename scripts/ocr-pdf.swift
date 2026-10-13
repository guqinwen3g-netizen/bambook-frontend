// ocr-pdf.swift —— 用 macOS Vision 框架对 PDF 做 OCR（中英双语）
//
// 为什么需要：BusinessDocu 里 99 份 PDF 有 46 份是**扫描图（无文本层）**，
// 其中包含**全部 44 份销售/采购合同** —— 那是合同条款的唯一来源。
//
// 用法：swiftc -O ocr-pdf.swift -o /tmp/ocr-pdf && /tmp/ocr-pdf <pdf> [<pdf> ...]
//
// 输出：每份 PDF 打到 stdout，用 "===== <文件名> =====" 分隔。
import Foundation
import Vision
import PDFKit
import CoreGraphics
import AppKit

func ocr(image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return "" }
    guard let obs = request.results else { return "" }
    return obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

/// PDF 页 → CGImage（按 2x 缩放提升 OCR 准确率）
func pageToImage(_ page: PDFPage, scale: CGFloat = 2.0) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
    guard w > 0, h > 0 else { return nil }
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

let args = Array(CommandLine.arguments.dropFirst())
guard !args.isEmpty else {
    FileHandle.standardError.write("用法: ocr-pdf <pdf> [<pdf> ...]\n".data(using: .utf8)!)
    exit(2)
}
for path in args {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        print("===== \(path) =====\n<打不开>")
        continue
    }
    var out: [String] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i), let img = pageToImage(page) else { continue }
        let t = ocr(image: img)
        if !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(t) }
    }
    print("===== \(path) =====")
    print(out.joined(separator: "\n--- 页分隔 ---\n"))
}
