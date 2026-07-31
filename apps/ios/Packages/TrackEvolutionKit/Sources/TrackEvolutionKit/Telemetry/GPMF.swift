import Foundation

/// GoPro GPMF telemetry parser (Hero 5 and later).
///
/// A port of `public/js/import/gpmf.js`, function for function and name for name
/// (`klvItems`, `parsePayload`, `parseGpmfFile`), with its test cases
/// (`test/unit/gpmf.test.js` → `GPMFTests`) and a cross-language fixture
/// (`contracts/logic/video-parsers.json`) pinning it to the JS output.
///
/// GoPro MP4s carry a metadata track (handler `meta`, sample format `gpmd`)
/// holding KLV-encoded telemetry — GPS fixes at 10–18 Hz among it. Like `PDR`,
/// only the MP4 index and the telemetry samples are read; the video essence is
/// never touched, let alone uploaded.
///
/// Format reference: https://github.com/gopro/gpmf-parser (openly documented by
/// GoPro). GoPro footage has no lap markers, so the trace goes to the
/// start/finish line picker and `Geo.deriveLaps` times the laps.
public enum GPMF {
    /// One GPMF item: `[key:4cc][type:u8][structSize:u8][repeat:u16 BE][data pad4]`.
    /// Type 0 is a nested container.
    public struct Item: Hashable, Sendable {
        public var key: String
        public var type: Int
        public var structSize: Int
        public var repeat_: Int
        /// Offset of the item's payload within the view.
        public var data: Int
        public var dataLen: Int
    }

    /// One GPS fix out of a payload, before it is placed on the clock.
    struct GPSSample {
        var lat: Double?
        var lon: Double?
        var v: Double?
    }

    /// What one payload yielded.
    struct Payload {
        var samples: [GPSSample] = []
        /// `GPSU`, the first one seen in the file: "yymmddhhmmss.sss" UTC.
        var utc: String?
    }

    /// Every KLV item in `[start, end)`. The JS is a generator; the walk is the
    /// same, and it stops rather than reading past the end.
    public static func klvItems(_ dv: ByteView, _ start: Int, _ end: Int) -> [Item] {
        var out: [Item] = []
        var p = start
        while p + 8 <= end {
            let key = MP4.fourcc(dv, p)
            let type = dv.getUint8(p + 4)
            let structSize = dv.getUint8(p + 5)
            let repeat_ = dv.getUint16(p + 6)
            let dataLen = structSize * repeat_
            if p + 8 + dataLen > end { break }
            out.append(
                Item(key: key, type: type, structSize: structSize, repeat_: repeat_, data: p + 8, dataLen: dataLen)
            )
            p += 8 + ((dataLen + 3) & ~3)
        }
        return out
    }

    static let TYPE_SIZES: [Character: Int] = [
        "b": 1, "B": 1, "c": 1, "s": 2, "S": 2, "l": 4, "L": 4, "f": 4, "d": 8, "j": 8, "J": 8,
        "F": 4, "U": 16,
    ]

    static func readTyped(_ dv: ByteView, _ off: Int, _ ch: Character) -> Double? {
        switch ch {
        case "b": Double(dv.getInt8(off))
        case "B": Double(dv.getUint8(off))
        case "s": Double(dv.getInt16(off))
        case "S": Double(dv.getUint16(off))
        case "l": Double(dv.getInt32(off))
        case "L": Double(dv.getUint32(off))
        case "f": dv.getFloat32(off)
        case "d": dv.getFloat64(off)
        default: nil
        }
    }

    /// Parse one telemetry payload; returns the GPS samples found in it.
    static func parsePayload(_ dv: ByteView, _ start: Int, _ end: Int) -> Payload {
        var out = Payload()

        func walkStream(_ s: Int, _ e: Int) {
            var scal: [Double]?
            var type9: [Character]?
            var gps5: Item?
            var gps9: Item?
            var fix: Int?
            for it in klvItems(dv, s, e) {
                switch it.key {
                case "SCAL":
                    // SCAL is int32 (or int64, rare).
                    var values: [Double] = []
                    let es = it.structSize == 8 ? 8 : 4
                    var i = 0
                    while i + es <= it.dataLen {
                        values.append(es == 8 ? Double(dv.getBigInt64(it.data + i)) : Double(dv.getInt32(it.data + i)))
                        i += es
                    }
                    scal = values
                case "TYPE":
                    type9 = Array(untilNul(dv.latin1(it.data, it.dataLen)))
                case "GPS5":
                    gps5 = it
                case "GPS9":
                    gps9 = it
                case "GPSF":
                    fix = dv.getUint32(it.data)
                case "GPSU":
                    if out.utc == nil { out.utc = untilNul(dv.latin1(it.data, it.dataLen)) }
                default:
                    break
                }
            }

            if let gps9, let type9, let scal {
                // GPS9: lat, lon, alt, 2D speed, 3D speed, days since 2000, secs, DOP, fix
                let sizes = type9.map { TYPE_SIZES[$0] ?? 0 }
                var offs: [Int] = []
                var acc = 0
                for sz in sizes {
                    offs.append(acc)
                    acc += sz
                }
                if acc != gps9.structSize { return }
                for i in 0..<gps9.repeat_ {
                    let base = gps9.data + i * gps9.structSize
                    func val(_ j: Int) -> Double? {
                        guard j < offs.count, j < type9.count else { return nil }
                        guard let v = readTyped(dv, base + offs[j], type9[j]) else { return nil }
                        return v / (j < scal.count ? scal[j] : 1)
                    }
                    if let sampleFix = val(8), sampleFix < 2 { continue }
                    out.samples.append(GPSSample(lat: val(0), lon: val(1), v: val(3)))
                }
            } else if let gps5, let scal, fix == nil || (fix ?? 0) >= 2 {
                // GPS5: lat, lon, alt, 2D speed, 3D speed — int32 BE, scaled by SCAL
                let n = gps5.dataLen / 20
                func scale(_ j: Int) -> Double { j < scal.count ? scal[j] : 1 }
                for i in 0..<n {
                    let base = gps5.data + i * 20
                    out.samples.append(
                        GPSSample(
                            lat: Double(dv.getInt32(base)) / scale(0),
                            lon: Double(dv.getInt32(base + 4)) / scale(1),
                            v: Double(dv.getInt32(base + 12)) / scale(3)
                        )
                    )
                }
            }
        }

        func walk(_ s: Int, _ e: Int) {
            for it in klvItems(dv, s, e) {
                if it.key == "STRM" {
                    walkStream(it.data, it.data + it.dataLen)
                } else if it.type == 0 {
                    walk(it.data, it.data + it.dataLen)
                }
            }
        }
        walk(start, end)
        return out
    }

    /// `.replace(/\0.*$/, "")` — GPMF pads its strings with NULs.
    private static func untilNul(_ s: String) -> String {
        guard let cut = s.firstIndex(of: "\0") else { return s }
        return String(s[s.startIndex..<cut])
    }

    // MARK: - MP4 plumbing

    public static func parseGpmfFile(_ source: some TelemetryByteSource) throws -> ParsedTelemetry {
        // 1. Locate moov among top-level boxes.
        let moovBox = try MP4.readMoov(source)
        let moov = moovBox.view
        let root = moovBox.root

        // 2. Find the GPMF track: handler 'meta' with sample format 'gpmd'.
        var stbl: MP4.Box?
        var timescale = 1000
        for trak in MP4.boxes(moov, root.body, root.size).filter({ $0.type == "trak" }) {
            guard let mdia = MP4.child(moov, trak, "mdia") else { continue }
            guard let minf = MP4.child(moov, mdia, "minf"),
                  let s = MP4.child(moov, minf, "stbl"),
                  let stsd = MP4.child(moov, s, "stsd")
            else { continue }
            let entry = MP4.boxes(moov, stsd.body + 8, stsd.start + stsd.size).first
            guard let entry, entry.type == "gpmd" else { continue }
            stbl = s
            if let mdhd = MP4.child(moov, mdia, "mdhd") {
                timescale = moov.getUint8(mdhd.body) == 1
                    ? moov.getUint32(mdhd.body + 20)
                    : moov.getUint32(mdhd.body + 12)
            }
            break
        }
        guard let stbl else {
            throw TelemetryParseError(message: "No GoPro GPMF telemetry track in this video", isNoTrack: true)
        }

        guard let stco = MP4.child(moov, stbl, "stco") ?? MP4.child(moov, stbl, "co64"),
              let stsz = MP4.child(moov, stbl, "stsz"),
              let stsc = MP4.child(moov, stbl, "stsc"),
              let stts = MP4.child(moov, stbl, "stts")
        else { throw TelemetryParseError(message: "GPMF track is missing sample tables") }

        // Sample sizes.
        let fixedSize = moov.getUint32(stsz.body + 4)
        let sampleCount = moov.getUint32(stsz.body + 8)
        func sizeAt(_ i: Int) -> Int {
            fixedSize != 0 ? fixedSize : moov.getUint32(stsz.body + 12 + i * 4)
        }

        // Sample start times (media units) from stts.
        var times: [Int] = []
        do {
            let n = moov.getUint32(stts.body + 4)
            var t = 0
            for e in 0..<n {
                let count = moov.getUint32(stts.body + 8 + e * 8)
                let delta = moov.getUint32(stts.body + 12 + e * 8)
                var i = 0
                while i < count && times.count <= sampleCount {
                    times.append(t)
                    t += delta
                    i += 1
                }
            }
            times.append(t)  // sentinel: end of last sample
        }

        // Sample file offsets via stsc + stco.
        let is64 = stco.type == "co64"
        let nChunks = moov.getUint32(stco.body + 4)
        func chunkOffset(_ i: Int) -> Int {
            is64
                ? Int(bitPattern: UInt(moov.getBigUint64(stco.body + 8 + i * 8)))
                : moov.getUint32(stco.body + 8 + i * 4)
        }
        let nStsc = moov.getUint32(stsc.body + 4)
        func stscEntry(_ i: Int) -> (firstChunk: Int, perChunk: Int) {
            (moov.getUint32(stsc.body + 8 + i * 12), moov.getUint32(stsc.body + 12 + i * 12))
        }

        var offsets: [Int] = []
        var sample = 0
        var e = 0
        while e < nStsc && sample < sampleCount {
            let cur = stscEntry(e)
            let nextFirst = e + 1 < nStsc ? stscEntry(e + 1).firstChunk : nChunks + 1
            var c = cur.firstChunk
            while c < nextFirst && sample < sampleCount {
                var off = chunkOffset(c - 1)
                var k = 0
                while k < cur.perChunk && sample < sampleCount {
                    offsets.append(off)
                    off += sizeAt(sample)
                    sample += 1
                    k += 1
                }
                c += 1
            }
            e += 1
        }

        // 3. Scan payloads for GPS samples, spreading each payload's fixes evenly
        // across its time span.
        var points: [Geo.Point] = []
        var utc: String?
        for i in 0..<offsets.count {
            // A user who picked the wrong 4 GB clip must be able to back out.
            try Task.checkCancellation()
            let dv = try bufAt(source, offsets[i], sizeAt(i))
            let payload = parsePayload(dv, 0, dv.byteLength)
            if utc == nil, let u = payload.utc { utc = u }
            if payload.samples.isEmpty { continue }
            let t0 = Double(times[i]) / Double(timescale)
            let t1 = Double(times[i + 1]) / Double(timescale)
            for (j, s) in payload.samples.enumerated() {
                guard let lat = s.lat, let lon = s.lon else { continue }
                points.append(
                    Geo.Point(
                        t: t0 + (Double(j) / Double(payload.samples.count)) * (t1 - t0),
                        lat: lat, lon: lon, v: s.v
                    )
                )
            }
        }
        if points.count < 10 {
            throw TelemetryParseError(message: "No GPS data in this video (was GPS enabled on the camera?)")
        }

        // GPSU: "yymmddhhmmss.sss" (UTC)
        var date: String?
        var time: String?
        if let utc, let stamp = utcStamp(utc) {
            date = "20\(stamp.0)-\(stamp.1)-\(stamp.2)"
            time = "\(stamp.3):\(stamp.4):\(stamp.5)"
        }

        return ParsedTelemetry(
            kind: .gopro,
            date: date,
            time: time,
            durationS: Double(times[times.count - 1]) / Double(timescale),
            laps: [],
            gps: points,
            needsLine: true
        )
    }

    /// `/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/` on a GPSU string.
    private static func utcStamp(_ utc: String) -> (String, String, String, String, String, String)? {
        let chars = Array(utc)
        guard chars.count >= 12, chars.prefix(12).allSatisfy(\.isASCIIDigit) else { return nil }
        func pair(_ i: Int) -> String { String(chars[i * 2]) + String(chars[i * 2 + 1]) }
        return (pair(0), pair(1), pair(2), pair(3), pair(4), pair(5))
    }
}
