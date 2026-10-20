// Writes Vision's foreground subject mask for each image, as OUT_DIR/<name>-<instance>.png
// (8-bit grey, 255 where the subject is), for matte.py to tell the hand from the wall.
// Needs macOS 14 or later.
//   swift scripts/hand/lift.swift OUT_DIR IMAGE...
import CoreImage
import Foundation
import Vision

let arguments = CommandLine.arguments
let outDir = URL(fileURLWithPath: arguments[1])
let context = CIContext()
for path in arguments.dropFirst(2) {
    let input = URL(fileURLWithPath: path)
    let handler = VNImageRequestHandler(url: input)
    let request = VNGenerateForegroundInstanceMaskRequest()
    try handler.perform([request])
    let name = input.deletingPathExtension().lastPathComponent
    // No subject at all leaves no mask: the frame is all wall.
    guard let observation = request.results?.first else { continue }
    for instance in observation.allInstances {
        let mask = try observation.generateScaledMaskForImage(
            forInstances: IndexSet(integer: instance), from: handler)
        try context.writePNGRepresentation(
            of: CIImage(cvPixelBuffer: mask),
            to: outDir.appendingPathComponent("\(name)-\(instance).png"),
            format: .L8,
            colorSpace: CGColorSpaceCreateDeviceGray())
    }
}
