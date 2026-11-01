import Foundation
import AVFoundation
import CoreVideo

struct MediaInfo {
    let duration: Double
    let width: Int
    let height: Int
    let bytes: Int64
    let decodedFrames: Int
    let lastFrameSeconds: Double
    var json: [String: Any] { ["durationSeconds": duration, "width": width, "height": height, "bytes": bytes, "decodedFrames": decodedFrames, "lastFrameSeconds": lastFrameSeconds] }
}
func inspectMovie(_ url: URL) async throws -> MediaInfo {
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    guard duration.isFinite && duration > 0,
          let track = try await asset.loadTracks(withMediaType: .video).first else {
        throw RecorderError("invalid_media", "The file has no video track with positive duration.")
    }
    let size = try await track.load(.naturalSize)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    guard reader.startReading() else {
        throw RecorderError("invalid_media", "Cannot start complete video validation.")
    }
    let nominalFPS = Double(try await track.load(.nominalFrameRate))
    let tolerance = max(0.05, nominalFPS > 0 ? min(1.005, 1 / nominalFPS + 0.005) : 0.05)
    var frames = 0
    var first = Double.infinity
    var last = -Double.infinity
    while let sample = output.copyNextSampleBuffer() {
        guard CMSampleBufferGetImageBuffer(sample) != nil else {
            throw RecorderError("invalid_media", "A video sample could not be decoded.")
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        guard pts.isFinite else { throw RecorderError("invalid_media", "Invalid frame timestamp.") }
        first = min(first, pts); last = max(last, pts); frames += 1
    }
    guard reader.status == .completed, frames > 0, abs(first) < 0.05,
          last >= duration - tolerance, last <= duration + 0.05 else {
        throw RecorderError("invalid_media", "Decoded frames do not cover the complete movie timeline (last frame \(last), movie \(duration)).")
    }
    let bytes = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
    guard bytes > 0 else { throw RecorderError("write_failed", "The recording file is empty.") }
    return MediaInfo(duration: duration, width: Int(size.width), height: Int(size.height), bytes: bytes, decodedFrames: frames, lastFrameSeconds: last)
}
func makeWriter(_ url: URL, width: Int, height: Int, fps: Int) throws -> (AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor) {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width, AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [AVVideoExpectedSourceFrameRateKey: fps, AVVideoAverageBitRateKey: max(2_000_000, width * height * 5)]])
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
    guard writer.startWriting() else { throw RecorderError("write_failed", writer.error?.localizedDescription ?? "Cannot start MP4 writer.") }
    writer.startSession(atSourceTime: .zero)
    return (writer, input, adaptor)
}
func appendPixel(_ pixel: CVPixelBuffer, at time: CMTime, input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor, writer: AVAssetWriter) throws {
    let deadline = Date().addingTimeInterval(20)
    while !input.isReadyForMoreMediaData {
        guard writer.status == .writing, Date() < deadline else { throw RecorderError("write_failed", writer.error?.localizedDescription ?? "MP4 writer stalled.") }
        Thread.sleep(forTimeInterval: 0.005)
    }
    guard adaptor.append(pixel, withPresentationTime: time) else { throw RecorderError("write_failed", writer.error?.localizedDescription ?? "Cannot append frame.") }
}
func finishWriter(_ writer: AVAssetWriter, input: AVAssetWriterInput, end: CMTime) async throws {
    writer.endSession(atSourceTime: end)
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else { throw RecorderError("write_failed", writer.error?.localizedDescription ?? "MP4 finalization failed.") }
}
// Native recordings can advertise a movie/edit duration beyond their last sample.
// Always encode real terminal samples, preserving the last real cursor pixels.
func appendFrozenTail(source: URL, destination: URL, seconds: Double, fps: Int, minimumDuration: Double = 0) async throws {
    let asset = AVURLAsset(url: source)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw RecorderError("invalid_media", "No video track.") }
    let size = try await track.load(.naturalSize)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    let (writer, input, adaptor) = try makeWriter(destination, width: Int(size.width), height: Int(size.height), fps: fps)
    defer {
        if reader.status == .reading { reader.cancelReading() }
        if writer.status == .writing { writer.cancelWriting() }
    }
    guard reader.startReading() else { throw RecorderError("invalid_media", "Cannot decode recording.") }
    var first: CMTime?; var last: CVPixelBuffer?; var lastTime = CMTime.zero
    while let sample = output.copyNextSampleBuffer() {
        guard let pixel = CMSampleBufferGetImageBuffer(sample) else { continue }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        if first == nil { first = pts }
        let relative = CMTimeSubtract(pts, first!)
        guard relative.seconds.isFinite, relative.seconds >= 0,
              last == nil || CMTimeCompare(relative, lastTime) > 0 else {
            throw RecorderError("invalid_media", "Recording frame timestamps are not strictly increasing.")
        }
        try appendPixel(pixel, at: relative, input: input, adaptor: adaptor, writer: writer)
        last = pixel; lastTime = relative
    }
    guard reader.status == .completed, let pixel = last else { writer.cancelWriting(); throw RecorderError("invalid_media", "Could not decode the complete recording.") }
    let step = CMTime(value: 1, timescale: CMTimeScale(fps))
    let nativeDuration = try await asset.load(.duration).seconds
    guard nativeDuration.isFinite, nativeDuration > 0, minimumDuration.isFinite else {
        writer.cancelWriting()
        throw RecorderError("invalid_media", "Invalid recording duration.")
    }
    let endSeconds = max(nativeDuration, minimumDuration, lastTime.seconds + step.seconds) + seconds
    let end = CMTime(seconds: endSeconds, preferredTimescale: 60000)
    var next = CMTimeAdd(lastTime, step)
    while CMTimeCompare(next, end) < 0 {
        try appendPixel(pixel, at: next, input: input, adaptor: adaptor, writer: writer)
        next = CMTimeAdd(next, step)
    }
    try await finishWriter(writer, input: input, end: end)
}
func syntheticMovie(_ path: String) async throws -> [String: Any] {
    let reservation = try OutputReservation(path: path)
    let (writer, input, adaptor) = try makeWriter(reservation.partial, width: 320, height: 180, fps: 60)
    for index in 0..<60 {
        var optional: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 320, 180, kCVPixelFormatType_32BGRA, nil, &optional)
        guard let pixel = optional else { throw RecorderError("write_failed", "Cannot allocate synthetic frame.") }
        CVPixelBufferLockBaseAddress(pixel, [])
        if let address = CVPixelBufferGetBaseAddress(pixel) { memset(address, Int32(index < 30 ? 45 : 180), CVPixelBufferGetBytesPerRow(pixel) * 180) }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        try appendPixel(pixel, at: CMTime(value: Int64(index), timescale: 60), input: input, adaptor: adaptor, writer: writer)
    }
    try await finishWriter(writer, input: input, end: CMTime(value: 1, timescale: 1))
    let tailURL = reservation.partial.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tail.mp4")
    try await appendFrozenTail(source: reservation.partial, destination: tailURL, seconds: 0.5, fps: 60)
    let info = try await inspectMovie(tailURL)
    guard info.duration >= 1.49 && info.duration <= 1.55 else { throw RecorderError("invalid_media", "Synthetic tail duration mismatch.") }
    try reservation.commit(tailURL)
    try? FileManager.default.removeItem(at: reservation.partial)
    return response(true, "synthetic_media_verified", "Synthetic MP4 and frozen-tail encoder verified without screen capture.", info.json.merging(["output": reservation.url.path]) { _, new in new })
}
