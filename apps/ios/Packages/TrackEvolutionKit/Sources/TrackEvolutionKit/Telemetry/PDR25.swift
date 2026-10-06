import Foundation

/// Cosworth "AliveDrive PDR 2.5" video telemetry parser — the recorder in
/// 2025-on GM performance cars (first seen on a Cadillac CT5-V Blackwing).
///
/// A port of `public/js/import/pdr25.js`, step for step and name for name
/// (`STORAGE_WIDTH`, `readStored`, `CHANNELS_25`, `parseChannelTable`,
/// `parseSchedule`, `parsePdr25File`), pinned to it by
/// `contracts/logic/video-parsers.json` (`pdr25-*.mp4`). Like `PDR` it reads only
/// the MP4 index and the telemetry samples, and it resolves to the shape
/// `PDR.parsePdrFile` does — same `kind`, same channels in the same display units
/// — so the review and the stored session are unchanged.
///
/// It is a different format from the Corvette's Marlin `ctbx` track, not a new
/// revision of it: nothing is delta-encoded, and the file describes itself
/// completely. The JS header is the specification; in short:
///
/// The track has handler `adrv` and sample entry `adco`, whose child boxes are
/// `adop` (outing properties: `name\0` + 4cc type + value; `timestamp` is a
/// 25-character `dtim` that is **local** wall-clock time despite its `+00:00`),
/// `adcp` (channels: `[u16 id] com.cosworth.channel.<name>\0 [u16 unit][u8 kind]
/// [u8 fmt]`, then for kind 1 f64 mult and f64 off to SI, for kind 2 an enum whose
/// storage code is `fmt`), `adcr` (u8 version, u16 nGroups, per group u64 period
/// in 100 ns, u16 n, n × [u16 id, u8 storage]) and `adeg` (`[u16 id]
/// com.cosworth.event.<name>\0`). Storage codes: 1 s8, 2 u8, 3 s16, 4 u16, 5 s32,
/// 6 u32, 9 f32.
///
/// The samples are one stream of blocks: `[u64 ts][u8 type]`, then for type 1
/// `[u8 0][u32 length]` and one second of **untagged** records — at every tick of
/// the fastest group, each group whose period divides the tick's offset writes its
/// fields, groups in `adcr` order — and for type 2 a `u16` event id. Laps are
/// `lap.start` / `lap.end` events.
///
/// Traps the port inherits: `accelerometer.vehicle.x` is **lateral** and
/// `vehicle.y` **longitudinal with braking positive**; enums are read by label
/// (the stability-enhancement channel numbers active as 0); wheel speeds are
/// front/rear; there is no battery-voltage channel and no recording odometer.
public enum PDR25 {
    /// Storage code → byte width. Anything else can't be framed.
    public static let STORAGE_WIDTH: [Int: Int] = [1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 9: 4]

    public static func readStored(_ dv: ByteView, _ off: Int, _ code: Int) -> Double {
        switch code {
        case 1: Double(dv.getInt8(off))
        case 2: Double(dv.getUint8(off))
        case 3: Double(dv.getInt16(off))
        case 4: Double(dv.getUint16(off))
        case 5: Double(dv.getInt32(off))
        case 6: Double(dv.getUint32(off))
        case 9: dv.getFloat32(off)
        default: .nan
        }
    }

    private static let RAD = 180 / Double.pi
    private static let G = 9.80665
    private static let K = -273.15

    /// Cosworth channel name → (the key this parser knows it by, factor, offset):
    /// the SI value times the factor plus the offset is the display unit
    /// `PDR.parsePdrFile` hands on. Enum channels carry no conversion.
    public static let CHANNELS_25: [String: (key: String, f: Double, add: Double)] = [
        "speed": ("speed", 3.6, 0),
        "location.latitude": ("latitude", RAD, 0),
        "location.longitude": ("longitude", RAD, 0),
        "location.altitude": ("altitude", 1, 0),
        "location.fixquality": ("fix", 1, 0),
        "enginespeed": ("rpm", 60 / (2 * Double.pi), 0),
        // the axis swap — see the type comment
        "accelerometer.vehicle.x": ("latAcc", 1 / G, 0),
        "accelerometer.vehicle.y": ("longAcc", -1 / G, 0),
        "throttle.position": ("throttle", 100, 0),
        "brake.position": ("brake", 100, 0),
        "steeringangle": ("steering", RAD, 0),
        "gyro.vehicle.yaw": ("yaw", RAD, 0),
        "gear": ("gear", 1, 0),
        "engine.pressure.airintake.boost": ("boost", 0.001, 0),
        "wheel.speed.front.left": ("wsFL", 3.6, 0),
        "wheel.speed.front.right": ("wsFR", 3.6, 0),
        "wheel.speed.rear.left": ("wsRL", 3.6, 0),
        "wheel.speed.rear.right": ("wsRR", 3.6, 0),
        "stability.antilockbrakingsystem": ("absActive", 1, 0),
        "stability.tractioncontrolsystem": ("tcActive", 1, 0),
        "stability.electronicstabilitycontrol": ("vscActive", 1, 0),
        "engine.temperature.oil": ("oilC", 1, K),
        "engine.pressure.oil": ("oilKpa", 0.001, 0),
        "engine.temperature.coolant": ("coolantC", 1, K),
        "transmission.oil.temperature": ("transC", 1, K),
        "engine.level.fuel": ("fuelPct", 100, 0),
        "tire.pressure.front.left": ("tyreKpaLF", 0.001, 0),
        "tire.pressure.front.right": ("tyreKpaRF", 0.001, 0),
        "tire.pressure.rear.left": ("tyreKpaLR", 0.001, 0),
        "tire.pressure.rear.right": ("tyreKpaRR", 0.001, 0),
        "tire.temperature.front.left": ("tyreCLF", 1, K),
        "tire.temperature.front.right": ("tyreCRF", 1, K),
        "tire.temperature.rear.left": ("tyreCLR", 1, K),
        "tire.temperature.rear.right": ("tyreCRR", 1, K),
        "temperature.outsideair": ("ambientC", 1, K),
        "engine.temperature.airintake": ("intakeC", 1, K),
        "odometer.distance": ("carOdo", 0.001, 0),  // the car's lifetime odometer
    ]

    static let GEAR_LABELS = [
        "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
    ]

    static let CHANNEL_PREFIX = "com.cosworth.channel."
    static let EVENT_PREFIX = "com.cosworth.event."
    static let MAX_TICKS = 864_000_000_000.0  // 24h in 100 ns units: anything above is corrupt

    /// One `adcp` entry.
    public struct Channel: Sendable {
        public var name: String
        public var kind: Int
        public var mult: Double
        public var off: Double
        /// An enum's first field as label → value, default label included.
        public var labels: [String: Double]?
    }

    /// One `adcr` group: how often it writes, and what.
    public struct Group: Sendable {
        public var period: Double
        public var fields: [(id: Int, code: Int)]
        /// NaN when a field's storage code is unknown.
        public var bytes: Double
    }

    /// Where one channel's decoded samples go, and how they are scaled there.
    struct Sink {
        var key: String
        var f: Double
        var add: Double
        var mult: Double
        var off: Double
    }

    // MARK: - The self-description

    /// A NUL-terminated latin-1 string at `p`, and where the byte after its NUL is.
    static func cstr(_ dv: ByteView, _ p: Int, _ end: Int) -> (s: String, next: Int) {
        var e = p
        while e < end && dv.getUint8(e) != 0 { e += 1 }
        return (dv.latin1(p, e - p), e + 1)
    }

    /// The channel table, found entry by entry by name — the id sits in the two
    /// bytes before it — since entries can't be walked end to end without every
    /// enum's grammar.
    public static func parseChannelTable(_ dv: ByteView, _ start: Int, _ end: Int) -> [Int: Channel] {
        var out: [Int: Channel] = [:]
        let prefix = Array(CHANNEL_PREFIX.utf8)
        var i = indexOf(dv, prefix, from: start, end: end)
        while let at = i {
            let (s, p) = cstr(dv, at, end)
            if at - 2 >= start && p + 4 <= end {
                let id = dv.getUint16(at - 2)
                let kind = dv.getUint8(p + 2)
                let fmt = dv.getUint8(p + 3)
                var ch = Channel(
                    name: String(s.dropFirst(CHANNEL_PREFIX.count)), kind: kind, mult: 1, off: 0, labels: nil
                )
                if kind == 1 && p + 20 <= end {
                    ch.mult = dv.getFloat64(p + 4)
                    ch.off = dv.getFloat64(p + 12)
                } else if kind == 2 {
                    ch.labels = enumLabels(dv, p + 4, end, fmt)
                }
                out[id] = ch
            }
            i = indexOf(dv, prefix, from: at + prefix.count, end: end)
        }
        return out
    }

    /// `text.indexOf(prefix, from)` over the bytes of the window — the JS decodes
    /// the table as latin-1 and searches that, which is the same thing.
    private static func indexOf(_ dv: ByteView, _ needle: [UInt8], from: Int, end: Int) -> Int? {
        guard !needle.isEmpty else { return nil }
        var i = from
        while i + needle.count <= end {
            var match = true
            for (k, b) in needle.enumerated() where dv.getUint8(i + k) != Int(b) {
                match = false
                break
            }
            if match { return i }
            i += 1
        }
        return nil
    }

    /// The first field of an enum entry; nil when its storage width is unknown
    /// or the entry runs out.
    static func enumLabels(_ dv: ByteView, _ start: Int, _ end: Int, _ code: Int) -> [String: Double]? {
        guard let w = STORAGE_WIDTH[code], start + 1 <= end else { return nil }
        var labels: [String: Double] = [:]
        var p = start + 1  // nFields: every enum this reads has one
        p = cstr(dv, p, end).next  // the field's name
        p += w  // its mask
        let def = cstr(dv, p, end)
        p = def.next
        if p + w + 1 > end { return nil }
        labels[def.s] = readStored(dv, p, code)
        p += w
        let count = dv.getUint8(p)
        p += 1
        for _ in 0..<count {
            let l = cstr(dv, p, end)
            p = l.next
            if p + w > end { return nil }
            labels[l.s] = readStored(dv, p, code)
            p += w
        }
        return labels
    }

    /// The record schedule.
    public static func parseSchedule(_ dv: ByteView, _ start: Int, _ end: Int) -> [Group] {
        var groups: [Group] = []
        var p = start + 1  // version
        if p + 2 > end { return groups }
        let n = dv.getUint16(p)
        p += 2
        var g = 0
        while g < n && p + 10 <= end {
            let period = Double(dv.getUint32(p)) * 4_294_967_296 + Double(dv.getUint32(p + 4))
            let count = dv.getUint16(p + 8)
            p += 10
            var fields: [(id: Int, code: Int)] = []
            var bytes = 0.0
            var k = 0
            while k < count && p + 3 <= end {
                let code = dv.getUint8(p + 2)
                fields.append((dv.getUint16(p), code))
                bytes += STORAGE_WIDTH[code].map(Double.init) ?? .nan
                p += 3
                k += 1
            }
            groups.append(Group(period: period, fields: fields, bytes: bytes))
            g += 1
        }
        return groups
    }

    static func parseEvents(_ dv: ByteView, _ start: Int, _ end: Int) -> [Int: String] {
        var out: [Int: String] = [:]
        var p = start
        while p + 2 < end {
            let id = dv.getUint16(p)
            let (s, next) = cstr(dv, p + 2, end)
            if s.hasPrefix(EVENT_PREFIX) { out[id] = String(s.dropFirst(EVENT_PREFIX.count)) }
            p = next
        }
        return out
    }

    // MARK: - The file

    public static func parsePdr25File(_ source: some TelemetryByteSource) throws -> ParsedTelemetry {
        // 1. Locate moov among top-level boxes (usually at file end).
        let moovBox = try MP4.readMoov(source)
        let moov = moovBox.view
        let root = moovBox.root

        // 2. Find the telemetry track (handler 'adrv').
        var stbl: MP4.Box?
        for trak in MP4.boxes(moov, root.body, root.size).filter({ $0.type == "trak" }) {
            guard let mdia = MP4.child(moov, trak, "mdia") else { continue }
            guard let hdlr = MP4.child(moov, mdia, "hdlr"),
                  MP4.fourcc(moov, hdlr.body + 8) == "adrv"
            else { continue }
            let minf = MP4.child(moov, mdia, "minf")
            stbl = minf.flatMap { MP4.child(moov, $0, "stbl") }
        }
        guard let stbl else {
            throw TelemetryParseError(message: "No PDR 2.5 telemetry track in this video", isNoTrack: true)
        }
        guard let stco = MP4.child(moov, stbl, "stco") ?? MP4.child(moov, stbl, "co64"),
              let stsz = MP4.child(moov, stbl, "stsz"),
              let stsc = MP4.child(moov, stbl, "stsc"),
              let stsd = MP4.child(moov, stbl, "stsd")
        else { throw TelemetryParseError(message: "Telemetry track is missing sample tables") }

        // 3. The self-description inside the 'adco' sample entry.
        let entry = MP4.boxes(moov, stsd.body + 8, stsd.start + stsd.size).first
        let parts = entry.map { MP4.boxes(moov, $0.body + 8, $0.start + $0.size) } ?? []
        func part(_ type: String) -> MP4.Box? { parts.first { $0.type == type } }
        guard let adcp = part("adcp"), let adcr = part("adcr") else {
            throw TelemetryParseError(message: "PDR 2.5 telemetry is missing its channel table")
        }
        let chans = parseChannelTable(moov, adcp.body, adcp.start + adcp.size)
        let groups = parseSchedule(moov, adcr.body, adcr.start + adcr.size).filter { !$0.fields.isEmpty }
        if groups.isEmpty || groups.contains(where: { !$0.bytes.isFinite || !($0.period > 0) }) {
            throw TelemetryParseError(message: "This PDR 2.5 recording uses a record layout this importer can't read")
        }
        let eventNames = part("adeg").map { parseEvents(moov, $0.body, $0.start + $0.size) } ?? [:]

        var date: String?
        var time: String?
        if let adop = part("adop") {
            let raw = moov.latin1(adop.body, adop.size - 8)
            if let stamp = PDR.firstMatch(
                raw, after: "outingproperty.timestamp\u{0}dtim", shape: "dddd-dd-ddTdd:dd:dd"
            ) {
                date = String(stamp.prefix(10))
                time = String(stamp.suffix(8))
            }
        }

        // 4. Decode the samples. One bucket per channel this parser reads, in
        // display units; every other field is stepped over by its width. The
        // JS keys a Map by channel id; here each scheduled field carries its
        // bucket's index, so the decode loop does no lookup at all.
        var sinks: [Sink] = []
        var sinkOfId: [Int: Int] = [:]
        for id in chans.keys.sorted() {
            guard let ch = chans[id], let spec = CHANNELS_25[ch.name] else { continue }
            sinkOfId[id] = sinks.count
            sinks.append(Sink(key: spec.key, f: spec.f, add: spec.add, mult: ch.mult, off: ch.off))
        }
        var buckets = [[ChannelPoint]](repeating: [], count: sinks.count)
        let plan = groups.map { g in
            (period: g.period, bytes: Int(g.bytes),
             fields: g.fields.map { (code: $0.code, width: STORAGE_WIDTH[$0.code] ?? 0, sink: sinkOfId[$0.id]) })
        }
        let tick = groups.map(\.period).min() ?? 1
        var events: [(t: Double, name: String)] = []
        var lastT = 0.0

        // Chunks hold whole samples and samples hold whole blocks, but nothing
        // promises a block never straddles a sample, so the stream is read whole.
        let is64 = stco.type == "co64"
        let nChunks = moov.getUint32(stco.body + 4)
        let fixedSize = moov.getUint32(stsz.body + 4)
        let nSamples = moov.getUint32(stsz.body + 8)
        func sizeAt(_ i: Int) -> Int { fixedSize != 0 ? fixedSize : moov.getUint32(stsz.body + 12 + i * 4) }
        let nRuns = moov.getUint32(stsc.body + 4)
        func runFirst(_ r: Int) -> Int { moov.getUint32(stsc.body + 8 + r * 12) }  // 1-based chunk
        func runPer(_ r: Int) -> Int { moov.getUint32(stsc.body + 12 + r * 12) }
        var stream: [UInt8] = []
        var sample = 0
        var r = 0
        var c = 0
        while c < nChunks && sample < nSamples {
            try Task.checkCancellation()
            while r + 1 < nRuns && runFirst(r + 1) <= c + 1 { r += 1 }
            let off = is64
                ? Int(bitPattern: UInt(moov.getBigUint64(stco.body + 8 + c * 8)))
                : moov.getUint32(stco.body + 8 + c * 4)
            var len = 0
            var k = 0
            while k < runPer(r) && sample < nSamples {
                len += sizeAt(sample)
                sample += 1
                k += 1
            }
            stream.append(contentsOf: try bufAt(source, off, len).bytes)
            c += 1
        }
        let s = ByteView(stream)

        var q = 0
        while q + 9 <= s.byteLength {
            let ts = Double(s.getUint32(q)) * 4_294_967_296 + Double(s.getUint32(q + 4))
            let type = s.getUint8(q + 8)
            if type == 2 {
                if q + 11 > s.byteLength { break }
                if ts <= MAX_TICKS, let name = eventNames[s.getUint16(q + 9)] {
                    events.append((ts / 1e7, name))
                }
                q += 11
                continue
            }
            if type != 1 || q + 14 > s.byteLength { break }  // a block that can't be framed
            let end = Swift.min(q + 14 + s.getUint32(q + 10), s.byteLength)
            var p = q + 14
            if ts <= MAX_TICKS {
                var k = 0.0
                while p < end {
                    let at = k * tick
                    for g in plan {
                        if at.truncatingRemainder(dividingBy: g.period) != 0 { continue }
                        if p + g.bytes > end {
                            p = end
                            break
                        }
                        let t = (ts + at) / 1e7
                        for fl in g.fields {
                            if let i = fl.sink {
                                let raw = readStored(s, p, fl.code)
                                let sink = sinks[i]
                                buckets[i].append(ChannelPoint(t: t, v: (raw * sink.mult + sink.off) * sink.f + sink.add))
                            }
                            p += fl.width
                        }
                        if t > lastT { lastT = t }
                    }
                    k += 1
                }
            }
            q = end
        }
        for e in events where e.t > lastT { lastT = e.t }

        var bucketOfKey: [String: Int] = [:]
        for (i, sink) in sinks.enumerated() { bucketOfKey[sink.key] = i }  // the last wins, as in the JS
        func got(_ key: String) -> [ChannelPoint] { bucketOfKey[key].map { buckets[$0] } ?? [] }
        func labelsOf(_ key: String) -> [String: Double]? {
            for id in chans.keys.sorted() {
                if let ch = chans[id], CHANNELS_25[ch.name]?.key == key { return ch.labels }
            }
            return nil
        }

        // Scale and derive the car channels, exactly as `PDR.parsePdrFile` does.
        let speed = got("speed")  // km/h
        let rpm = got("rpm")
        let latAcc = got("latAcc")  // G
        let throttle = got("throttle")  // %
        let brake = got("brake")  // %
        let longAcc = got("longAcc")  // G, signed: negative under braking
        let yaw = got("yaw")  // deg/s, signed
        let boost = got("boost")  // kPa gauge
        let steering = got("steering")  // deg, signed

        // Gear by label: first..tenth are gears, anything else is the no-gear 0.
        var gearOf: [Double: Double] = [:]
        if let gearLabels = labelsOf("gear") {
            for (i, l) in GEAR_LABELS.enumerated() {
                if let v = gearLabels[l] { gearOf[v] = Double(i + 1) }
            }
        }
        let gear = gearOf.isEmpty ? [] : got("gear").map { ChannelPoint(t: $0.t, v: gearOf[$0.v] ?? 0) }

        // Wheel slip, rear over front, as one channel.
        let wheel = ["wsFL", "wsFR", "wsRL", "wsRR"].map(got)
        var wheelSlip: [ChannelPoint] = []
        if wheel.allSatisfy({ $0.count > 10 }) {
            let fl = series(wheel[0]), fr = series(wheel[1])
            let rl = series(wheel[2]), rr = series(wheel[3])
            wheelSlip = wheel[0].map { p in
                let nd = (fl.at(p.t) + fr.at(p.t)) / 2
                let dr = (rl.at(p.t) + rr.at(p.t)) / 2
                let v = nd < 5 ? 0 : ((dr - nd) / nd) * 100
                return ChannelPoint(t: p.t, v: Swift.max(-100, Swift.min(100, v)))
            }
        }

        // ABS / traction control / stability control, each 1 while "active".
        func active(_ key: String) -> [ChannelPoint] {
            guard let v = labelsOf(key)?["active"] else { return [] }
            return got(key).map { ChannelPoint(t: $0.t, v: $0.v == v ? 1 : 0) }
        }
        let absPts = active("absActive")
        let tcPts = active("tcActive")
        let vscPts = active("vscActive")
        var flags: [ChannelPoint] = []
        if absPts.count > 10 {
            let tc = tcPts.count > 10 ? series(tcPts) : nil
            let vsc = vscPts.count > 10 ? series(vscPts) : nil
            flags = absPts.map { p in
                var bits = p.v > 0.5 ? 1 : 0
                if let tc, tc.at(p.t) > 0.5 { bits |= 2 }
                if let vsc, vsc.at(p.t) > 0.5 { bits |= 4 }
                return ChannelPoint(t: p.t, v: Double(bits))
            }
        }

        var lapScalarChannels: [String: [ChannelPoint]] = [:]
        for key in PDR.SCALAR_CHANNEL_KEYS {
            let arr = got(key)
            if !arr.isEmpty { lapScalarChannels[key] = arr }
        }

        func maxOf(_ pts: [ChannelPoint], _ cap: Double) -> Double? {
            var m = -Double.infinity
            for p in pts where p.v > m { m = p.v }
            return m > 0 && m < cap ? m : nil
        }
        func absSeries(_ arr: [ChannelPoint]) -> [ChannelPoint] {
            arr.map { ChannelPoint(t: $0.t, v: abs($0.v)) }
        }
        let metrics = ParsedTelemetry.Metrics(
            topSpeedKph: maxOf(speed, 500),
            maxRpm: maxOf(rpm, 20000),
            maxLatG: maxOf(absSeries(latAcc), 5),
            maxBrakeG: maxOf(longAcc.map { ChannelPoint(t: $0.t, v: -$0.v) }, 5),
            maxBoostKpa: maxOf(boost, 400),
            maxOilC: maxOf(got("oilC"), 250)
        )

        // GPS: one record group carries position, fix quality and speed, so the
        // samples line up by index; fixes without a position are dropped.
        let lat = got("latitude"), lon = got("longitude"), alt = got("altitude"), fix = got("fix")
        var gps: [Geo.Point] = []
        var fixedAlt: [ChannelPoint] = []
        for i in lat.indices {
            let t = lat[i].t
            guard i < lon.count, lon[i].t == t, i < fix.count, fix[i].t == t, fix[i].v > 0 else { continue }
            let la = lat[i].v, lo = lon[i].v
            guard abs(la) <= 90 && abs(lo) <= 180, !(la == 0 && lo == 0) else { continue }
            let v: Double? = i < speed.count && speed[i].t == t ? speed[i].v / 3.6 : nil
            gps.append(Geo.Point(t: t, lat: la, lon: lo, v: v))
            if i < alt.count && alt[i].t == t { fixedAlt.append(alt[i]) }
        }

        func median(_ arr: [ChannelPoint]) -> Double? {
            guard arr.count >= 3 else { return nil }
            let v = arr.map(\.v).sorted()
            return v[v.count >> 1]
        }
        let carOdo = got("carOdo")
        let sessionMeta = ParsedTelemetry.SessionMeta(
            ambientC: median(got("ambientC")),
            intakeC: median(got("intakeC")),
            elevationM: fixedAlt.count > 10
                ? (fixedAlt.map(\.v).max() ?? 0) - (fixedAlt.map(\.v).min() ?? 0)
                : nil,
            odometerKm: carOdo.isEmpty ? nil : carOdo.map(\.v).max()
        )

        // 5. Laps between a lap.start and the next lap.end; ends sort first at a
        // shared timestamp, and a start with no end is not a lap.
        let lapEvents = events.enumerated()
            .filter { $0.element.name == "lap.start" || $0.element.name == "lap.end" }
            .map { (t: $0.element.t, isEnd: $0.element.name == "lap.end", i: $0.offset) }
            .sorted { a, b in
                if a.t != b.t { return a.t < b.t }
                if a.isEnd != b.isEnd { return a.isEnd }
                return a.i < b.i
            }
        var laps: [ParsedLap] = []
        var open: Double?
        for e in lapEvents {
            if e.isEnd {
                if let start = open, e.t > start, let ms = JSMath.roundToInt((e.t - start) * 1000) {
                    laps.append(ParsedLap(lapNumber: laps.count + 1, timeMs: ms, estimated: false, startT: start, endT: e.t))
                }
                open = nil
            } else {
                open = e.t
            }
        }

        func dense(_ arr: [ChannelPoint]) -> [ChannelPoint]? { arr.count > 10 ? arr : nil }

        return ParsedTelemetry(
            kind: .pdr,
            date: date,
            time: time,
            durationS: lastT,
            laps: laps,
            gps: gps.count > 10 ? gps : nil,
            metrics: metrics,
            beaconCount: Set(lapEvents.map(\.t)).count,
            channels: nil,  // no recording odometer, so nothing for PDRLaps
            carChannels: ParsedTelemetry.CarChannels(
                speed: dense(speed),
                rpm: dense(rpm),
                latG: dense(absSeries(latAcc)),
                throttle: dense(throttle),
                brake: dense(brake),
                steering: dense(steering),
                longG: dense(longAcc),
                yaw: dense(yaw),
                gear: dense(gear),
                wheelSlip: dense(wheelSlip),
                boost: dense(boost),
                flags: dense(flags)
            ),
            lapScalarChannels: lapScalarChannels,
            sessionMeta: sessionMeta
        )
    }
}
