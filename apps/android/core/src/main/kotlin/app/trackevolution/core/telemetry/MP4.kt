package app.trackevolution.core.telemetry

/**
 * The MP4 box walking both telemetry parsers do before they reach their own
 * formats.
 *
 * A port of the `boxes` / `child` / `fourcc` trio that `public/pdr.js` and
 * `public/js/import/gpmf.js` each carry a copy of — same names, so the three
 * still diff by eye. The JS duplicates it because the two files are loaded
 * independently in the browser; here one copy serves both, as it does in the
 * iOS Kit's `MP4.swift`.
 */
public object MP4 {

    /**
     * One box: its four-character type, where its header starts, where its body
     * starts, and its total size including the header.
     */
    public data class Box(val type: String, val start: Int, val body: Int, val size: Int)

    /** A four-character code as latin-1, the way both parsers read one. */
    public fun fourcc(dv: ByteView, off: Int): String = dv.latin1(off, 4)

    /**
     * Consecutive box headers in `[start, end)`.
     *
     * Stops at the first thing that isn't a box rather than running away: a size
     * below the 8-byte header, a size that overruns the window, or a type that
     * isn't four printable ASCII characters. That is the only guard against a
     * malformed file spinning here forever.
     */
    public fun boxes(dv: ByteView, start: Int, end: Int): List<Box> {
        val out = ArrayList<Box>()
        var p = start
        while (p + 8 <= end) {
            var size = dv.getUint32(p)
            val type = fourcc(dv, p + 4)
            var hdr = 8
            if (size == 1L) {
                size = dv.getBigUint64(p + 8)
                hdr = 16
            }
            if (size == 0L) size = (end - p).toLong()
            if (size < 8 || p + size > end || !isPrintableFourcc(type)) break
            out.add(Box(type = type, start = p, body = p + hdr, size = size.toInt()))
            p += size.toInt()
        }
        return out
    }

    /** The first child box of [box] with the given type. */
    public fun child(dv: ByteView, box: Box, type: String): Box? =
        boxes(dv, box.body, box.start + box.size).firstOrNull { it.type == type }

    /** `/^[\x20-\x7e]{4}$/` — four printable ASCII characters, no more, no less. */
    private fun isPrintableFourcc(type: String): Boolean =
        type.length == 4 && type.all { it.code in 0x20..0x7e }

    /**
     * `moov` read into memory, plus the root box addressing it.
     *
     * Offsets inside [view] are relative to the start of `moov`, which is why
     * [root] is `{start: 0, body: 8}` — the same frame the JS works in, where
     * every `DataView` comes from a `Blob.slice`.
     */
    internal class Moov(val view: ByteView, val root: Box)

    /**
     * Locate `moov` among the top-level boxes — usually at the end of the file,
     * which is why this walks headers rather than reading the whole thing.
     *
     * Shared by both parsers, where it is step 1 of each.
     */
    internal fun readMoov(source: TelemetryByteSource): Moov {
        var pos = 0L
        while (pos + 16 <= source.size) {
            val hdr = bufAt(source, pos, 16)
            var size = hdr.getUint32(0)
            val type = fourcc(hdr, 4)
            if (size == 1L) size = hdr.getBigUint64(8)
            if (size == 0L) size = source.size - pos
            if (size < 8) throw TelemetryParseException("Not a valid MP4 file")
            if (type == "moov") {
                return Moov(
                    view = bufAt(source, pos, size),
                    root = Box(type = "moov", start = 0, body = 8, size = size.toInt()),
                )
            }
            pos += size
        }
        throw TelemetryParseException("No moov box found — is this an MP4?")
    }
}

/**
 * What a parser throws when a file isn't its own, or isn't a video at all.
 *
 * [isNoTrack] replaces the JS's `/No .* telemetry track/` test on the message:
 * [Telemetry.parseTelemetryFile] tries PDR then GoPro, and needs to tell "this
 * file simply isn't mine" (try the other parser) from "this file is mine and
 * it's broken" (report it). Same distinction, made explicitly rather than by
 * regex — the same call the iOS port made.
 */
public class TelemetryParseException(
    override val message: String,
    /** The file carries no track this parser recognises. */
    public val isNoTrack: Boolean = false,
) : Exception(message)
