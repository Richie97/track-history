package app.trackevolution.core.telemetry

/**
 * Random access to the bytes of a telemetry file.
 *
 * The seam that keeps the parsers free of `Uri`, `ContentResolver` and file
 * descriptors: [PDR] and [GPMF] read the MP4 index plus the telemetry track's
 * own samples — megabytes against a file one to two orders of magnitude larger
 * — and they do it through this. `:app` supplies an implementation over the
 * seekable descriptor `ContentResolver.openFileDescriptor` hands back; the
 * tests supply [ByteArraySource] over bytes in memory, which is what lets
 * `:core:test` run the whole port on the JVM.
 *
 * The JS counterpart is `Blob.slice().arrayBuffer()`, and this inherits its one
 * forgiving behaviour: a read past the end is **clamped, not an error**. Both
 * parsers rely on it, asking for a fixed-size header near the tail of a file.
 *
 * A read may throw `kotlinx.coroutines.CancellationException` — that is how the
 * app's implementation lets a driver back out of the wrong 4 GB clip mid-parse
 * while the parsers themselves stay identical to the JS.
 */
public interface TelemetryByteSource {
    /** Total size in bytes — `Blob.size` in the JS. */
    public val size: Long

    /**
     * Up to [count] bytes from [offset]. Returns fewer (or none) at the end of
     * the file rather than throwing.
     */
    public fun read(offset: Long, count: Int): ByteArray
}

/** A source over bytes already in memory, for tests and fixtures. */
public class ByteArraySource(private val data: ByteArray) : TelemetryByteSource {
    override val size: Long get() = data.size.toLong()

    override fun read(offset: Long, count: Int): ByteArray {
        if (offset < 0 || offset >= data.size || count <= 0) return ByteArray(0)
        val end = minOf(data.size.toLong(), offset + count).toInt()
        return data.copyOfRange(offset.toInt(), end)
    }
}

/**
 * Big-endian reads over a window of a file — the port's `DataView`.
 *
 * Offsets are relative to the window's start, exactly as they are in the JS,
 * where every `DataView` comes from a `Blob.slice`. Out-of-range reads return
 * zero rather than throwing: a truncated or malformed video must fail as "no
 * telemetry in this file", never as a crash in the middle of someone's paddock.
 */
public class ByteView(public val bytes: ByteArray) {

    /** `byteLength` in the JS. */
    public val byteLength: Int get() = bytes.size

    private fun byte(offset: Int): Long =
        if (offset < 0 || offset >= bytes.size) 0L else (bytes[offset].toLong() and 0xff)

    private fun be(offset: Int, width: Int): Long {
        var out = 0L
        for (i in 0 until width) out = (out shl 8) or byte(offset + i)
        return out
    }

    public fun getUint8(offset: Int): Int = byte(offset).toInt()
    public fun getInt8(offset: Int): Int = byte(offset).toByte().toInt()
    public fun getUint16(offset: Int): Int = be(offset, 2).toInt()
    public fun getInt16(offset: Int): Int = be(offset, 2).toShort().toInt()
    /** A u32 as a Long, since it doesn't fit a signed Int. */
    public fun getUint32(offset: Int): Long = be(offset, 4)
    public fun getInt32(offset: Int): Int = be(offset, 4).toInt()
    /** A u64 in a signed Long; every use compares it against a bound far below 2^63. */
    public fun getBigUint64(offset: Int): Long = be(offset, 8)
    public fun getBigInt64(offset: Int): Long = be(offset, 8)
    public fun getFloat32(offset: Int): Double = java.lang.Float.intBitsToFloat(getInt32(offset)).toDouble()
    public fun getFloat64(offset: Int): Double = java.lang.Double.longBitsToDouble(be(offset, 8))

    /**
     * `TextDecoder("latin1")` over a byte range: every byte is its own character.
     * Used for four-character codes and the PDR session-metadata box.
     */
    public fun latin1(offset: Int, count: Int): String {
        if (count <= 0) return ""
        val out = CharArray(count) { i -> byte(offset + i).toInt().toChar() }
        return String(out)
    }

    /**
     * A NUL-terminated UTF-8 string within [count] bytes — the PDR channel
     * dictionary's name and unit fields.
     */
    public fun utf8String(offset: Int, count: Int): String {
        var end = offset
        while (end < offset + count && byte(end) != 0L) end++
        if (end <= offset || offset < 0 || end > bytes.size) return ""
        return String(bytes, offset, end - offset, Charsets.UTF_8)
    }
}

/**
 * `bufAt` in both parsers: a window of the source as a [ByteView], clamped to
 * the end of the file.
 */
internal fun bufAt(source: TelemetryByteSource, offset: Long, length: Long): ByteView {
    val count = minOf(length, Int.MAX_VALUE.toLong()).toInt()
    return ByteView(source.read(offset, count))
}
