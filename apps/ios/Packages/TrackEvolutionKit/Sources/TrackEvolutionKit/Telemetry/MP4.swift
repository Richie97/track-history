import Foundation

/// The MP4 box walking both telemetry parsers do before they reach their own
/// formats.
///
/// A port of the `boxes` / `child` / `fourcc` trio that `public/pdr.js` and
/// `public/js/import/gpmf.js` each carry a copy of — same names, so the three
/// still diff by eye. The JS duplicates it because the two files are loaded
/// independently in the browser; here one copy serves both.
public enum MP4 {
    /// One box: its four-character type, where its header starts, where its body
    /// starts, and its total size including the header.
    public struct Box: Hashable, Sendable {
        public var type: String
        public var start: Int
        public var body: Int
        public var size: Int

        public init(type: String, start: Int, body: Int, size: Int) {
            self.type = type
            self.start = start
            self.body = body
            self.size = size
        }
    }

    /// A four-character code as latin-1, the way both parsers read one.
    public static func fourcc(_ dv: ByteView, _ off: Int) -> String {
        dv.latin1(off, 4)
    }

    /// Consecutive box headers in `[start, end)`.
    ///
    /// Stops at the first thing that isn't a box rather than running away: a size
    /// below the 8-byte header, a size that overruns the window, or a type that
    /// isn't four printable ASCII characters. That is the only guard against a
    /// malformed file spinning here forever.
    public static func boxes(_ dv: ByteView, _ start: Int, _ end: Int) -> [Box] {
        var out: [Box] = []
        var p = start
        while p + 8 <= end {
            var size = dv.getUint32(p)
            let type = fourcc(dv, p + 4)
            var hdr = 8
            if size == 1 {
                size = Int(bitPattern: UInt(dv.getBigUint64(p + 8)))
                hdr = 16
            }
            if size == 0 { size = end - p }
            if size < 8 || p + size > end || !isPrintableFourcc(type) { break }
            out.append(Box(type: type, start: p, body: p + hdr, size: size))
            p += size
        }
        return out
    }

    /// The first child box of `box` with the given type.
    public static func child(_ dv: ByteView, _ box: Box, _ type: String) -> Box? {
        boxes(dv, box.body, box.start + box.size).first { $0.type == type }
    }

    /// `/^[\x20-\x7e]{4}$/` — four printable ASCII characters, no more, no less.
    private static func isPrintableFourcc(_ type: String) -> Bool {
        let scalars = Array(type.unicodeScalars)
        guard scalars.count == 4 else { return false }
        return scalars.allSatisfy { $0.value >= 0x20 && $0.value <= 0x7e }
    }

    /// `moov` read into memory, plus the root box addressing it.
    ///
    /// Offsets inside `view` are relative to the start of `moov`, which is why
    /// `root` is `{start: 0, body: 8}` — the same frame the JS works in, where
    /// every `DataView` comes from a `Blob.slice`.
    struct Moov {
        var view: ByteView
        var root: Box
    }

    /// Locate `moov` among the top-level boxes — usually at the end of the file,
    /// which is why this walks headers rather than reading the whole thing.
    ///
    /// Shared by both parsers, where it is step 1 of each.
    static func readMoov(_ source: some TelemetryByteSource) throws -> Moov {
        var pos = 0
        while pos + 16 <= source.size {
            let hdr = try bufAt(source, pos, 16)
            var size = hdr.getUint32(0)
            let type = fourcc(hdr, 4)
            if size == 1 { size = Int(bitPattern: UInt(hdr.getBigUint64(8))) }
            if size == 0 { size = source.size - pos }
            if size < 8 { throw TelemetryParseError(message: "Not a valid MP4 file") }
            if type == "moov" {
                return Moov(
                    view: try bufAt(source, pos, size),
                    root: Box(type: "moov", start: 0, body: 8, size: size)
                )
            }
            pos += size
        }
        throw TelemetryParseError(message: "No moov box found — is this an MP4?")
    }
}

/// What a parser throws when a file isn't its own, or isn't a video at all.
///
/// `isNoTrack` replaces the JS's `/No .* telemetry track/` test on the message:
/// `parseTelemetryFile` tries PDR then GoPro, and needs to tell "this file simply
/// isn't mine" (try the other parser) from "this file is mine and it's broken"
/// (report it). Same distinction, made explicitly rather than by regex.
public struct TelemetryParseError: Error, Equatable, LocalizedError, Sendable {
    public var message: String
    /// The file carries no track this parser recognises.
    public var isNoTrack: Bool

    public init(message: String, isNoTrack: Bool = false) {
        self.message = message
        self.isNoTrack = isNoTrack
    }

    public var errorDescription: String? { message }
}
