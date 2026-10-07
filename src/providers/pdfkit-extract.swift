import Darwin
import Foundation
import PDFKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2 else {
    fail("Usage: pdfkit-extract.swift <pdf-path>")
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url) else {
    fail("Apple PDFKit could not open the PDF")
}

var pages: [String] = []
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
        pages.append(text)
    }
}

guard !pages.isEmpty else {
    fail("Apple PDFKit found no readable page text; scanned PDFs require OCR")
}

print(pages.joined(separator: "\n\u{000C}\n"))
