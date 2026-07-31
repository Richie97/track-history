import Foundation

/// Random access to the bytes of a telemetry file.
///
/// The seam that keeps the parsers (NS-30) free of `URL`, Photos and security
/// scopes: `PDR` and `GPMF` read the MP4 index plus the telemetry track's own
/// samples — megabytes against a file one to two orders of magnitude larger — and
/// they do it through this. The app supplies a `FileHandle`-backed implementation
/// over a security-scoped URL; the tests supply `DataByteSource` over bytes in
/// memory, which is what lets `swift test` run the whole port on macOS.
///
/// The JS counterpart is `Blob.slice().arrayBuffer()`, and this inherits its one
/// forgiving behaviour: a read past the end is **clamped, not an error**. Both
/// parsers rely on it, asking for a fixed-size header near the tail of a file.
///
/// Deliberately not `Sendable`. A parse is a single sequential walk confined to
/// one task, and a `FileHandle` shared across tasks would be a data race dressed
/// up as an optimisation.
public protocol TelemetryByteSource {
    /// Total size in bytes — `Blob.size` in the JS.
    var size: Int { get }

    /// Up to `count` bytes from `offset`. Returns fewer (or none) at the end of
    /// the file rather than throwing.
    func read(at offset: Int, count: Int) throws -> Data
}

/// A source over bytes already in memory, for tests and fixtures.
public struct DataByteSource: TelemetryByteSource, Sendable {
    public let data: Data

    public init(_ data: Data) {
        self.data = data
    }

    public var size: Int { data.count }

    public func read(at offset: Int, count: Int) throws -> Data {
        guard offset >= 0, offset < data.count, count > 0 else { return Data() }
        let end = Swift.min(data.count, offset + count)
        return data.subdata(in: offset..<end)
    }
}

/// Big-endian reads over a window of a file — the port's `DataView`.
///
/// Offsets are relative to the window's start, exactly as they are in the JS,
/// where every `DataView` comes from a `Blob.slice`. Out-of-range reads return
/// zero rather than trapping: a truncated or malformed video must fail as "no
/// telemetry in this file", never as a crash in the middle of someone's paddock.
public struct ByteView: Sendable {
    public let bytes: [UInt8]

    public init(_ data: Data) {
        bytes = [UInt8](data)
    }

    public init(_ bytes: [UInt8]) {
        self.bytes = bytes
    }

    /// `byteLength` in the JS.
    public var byteLength: Int { bytes.count }

    private func byte(_ offset: Int) -> UInt64 {
        guard offset >= 0, offset < bytes.count else { return 0 }
        return UInt64(bytes[offset])
    }

    private func be(_ offset: Int, _ width: Int) -> UInt64 {
        var out: UInt64 = 0
        for i in 0..<width { out = (out << 8) | byte(offset + i) }
        return out
    }

    public func getUint8(_ offset: Int) -> Int { Int(byte(offset)) }
    public func getInt8(_ offset: Int) -> Int { Int(Int8(bitPattern: UInt8(byte(offset)))) }
    public func getUint16(_ offset: Int) -> Int { Int(be(offset, 2)) }
    public func getInt16(_ offset: Int) -> Int { Int(Int16(bitPattern: UInt16(be(offset, 2)))) }
    public func getUint32(_ offset: Int) -> Int { Int(be(offset, 4)) }
    public func getInt32(_ offset: Int) -> Int { Int(Int32(bitPattern: UInt32(be(offset, 4)))) }
    public func getBigUint64(_ offset: Int) -> UInt64 { be(offset, 8) }
    public func getBigInt64(_ offset: Int) -> Int { Int(Int64(bitPattern: be(offset, 8))) }
    public func getFloat32(_ offset: Int) -> Double { Double(Float(bitPattern: UInt32(be(offset, 4)))) }
    public func getFloat64(_ offset: Int) -> Double { Double(bitPattern: be(offset, 8)) }

    /// `TextDecoder("latin1")` over a byte range: every byte is its own Unicode
    /// scalar. Used for four-character codes and the PDR session-metadata box.
    public func latin1(_ offset: Int, _ count: Int) -> String {
        var out = String.UnicodeScalarView()
        for i in 0..<Swift.max(0, count) {
            out.append(Unicode.Scalar(UInt8(byte(offset + i))))
        }
        return String(out)
    }

    /// A NUL-terminated UTF-8 string within `count` bytes — the PDR channel
    /// dictionary's name and unit fields.
    public func utf8String(_ offset: Int, _ count: Int) -> String {
        var end = offset
        while end < offset + count, byte(end) != 0 { end += 1 }
        guard end > offset, offset >= 0, end <= bytes.count else { return "" }
        return String(decoding: bytes[offset..<end], as: UTF8.self)
    }
}

/// `bufAt` in both parsers: a window of the source as a `ByteView`, clamped to
/// the end of the file.
func bufAt(_ source: some TelemetryByteSource, _ offset: Int, _ length: Int) throws -> ByteView {
    ByteView(try source.read(at: offset, count: length))
}

extension Character {
    /// `\d` in the parsers' two small patterns — ASCII only, unlike Swift's
    /// `isNumber`, which is true of "٣" and "½".
    var isASCIIDigit: Bool { self >= "0" && self <= "9" }
}
