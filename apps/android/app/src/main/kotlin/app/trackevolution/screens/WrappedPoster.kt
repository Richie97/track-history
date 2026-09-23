package app.trackevolution.screens

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.text.TextPaint
import androidx.compose.ui.graphics.toArgb
import androidx.core.content.FileProvider
import androidx.core.content.res.ResourcesCompat
import app.trackevolution.R
import app.trackevolution.core.WrappedStory
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.core.model.Wrapped
import app.trackevolution.ui.theme.DarkTrackColors
import app.trackevolution.ui.theme.LightTrackColors
import app.trackevolution.ui.theme.TrackColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Season Wrapped's poster as a picture (NS-36): 1080×1920 for a story, 1200×630
 * for everywhere else — the two sizes and layouts of `public/js/wrapped-image.js`,
 * drawn on an `android.graphics.Canvas` the way the web draws on a `<canvas>`,
 * with the words from [WrappedStory.posterLines] so the image can never say
 * something the card doesn't. In the viewer's theme, in the bundled Geist.
 *
 * Shared as a PNG in the cache's `wrapped/` directory through the manifest's
 * `FileProvider`, with a one-file read grant — `ACTION_SEND` of a content URI,
 * which every messenger and the Photos "save" target take.
 */
object WrappedPoster {
    const val STORY_W = 1080
    const val STORY_H = 1920
    const val WIDE_W = 1200
    const val WIDE_H = 630

    fun fileName(year: Int, wide: Boolean): String = "track-evolution-$year-wrapped${if (wide) "-wide" else ""}.png"

    /** Draws and shares; the draw and the file write run off the main thread. */
    suspend fun share(context: Context, data: Wrapped, units: UnitSystem, dark: Boolean, wide: Boolean) {
        val file = withContext(Dispatchers.Default) {
            val bitmap = draw(context, data, units, dark, wide)
            val dir = File(context.cacheDir, "wrapped").apply { mkdirs() }
            File(dir, fileName(data.year, wide)).also { f ->
                f.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.wrapped", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, WrappedStory.posterLines(data, units).title)
            // The ClipData is what lets the chooser show the image as its preview.
            clipData = ClipData.newRawUri(null, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }

    fun draw(context: Context, data: Wrapped, units: UnitSystem, dark: Boolean, wide: Boolean): Bitmap {
        val c = if (dark) DarkTrackColors else LightTrackColors
        val w = if (wide) WIDE_W else STORY_W
        val h = if (wide) WIDE_H else STORY_H
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val fonts = Fonts(context)
        background(canvas, w, h, c)
        if (wide) drawWide(canvas, data, units, c, fonts) else drawStory(canvas, data, units, c, fonts)
        return bitmap
    }

    private class Fonts(context: Context) {
        private val base: Typeface = runCatching { ResourcesCompat.getFont(context, R.font.geist_variable) }.getOrNull()
            ?: Typeface.SANS_SERIF

        fun weight(w: Int): Typeface =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(base, w, false)
            else Typeface.create(base, if (w >= 600) Typeface.BOLD else Typeface.NORMAL)
    }

    private fun paint(fonts: Fonts, size: Float, weight: Int, color: Int, spacing: Float = 0f) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fonts.weight(weight)
        textSize = size
        this.color = color
        letterSpacing = spacing
    }

    /** Greedy word wrap, a word longer than the line left whole — `wrapWords` in wrapped-image.js. */
    internal fun wrapWords(text: String, maxWidth: Float, measure: (String) -> Float): List<String> {
        val lines = mutableListOf<String>()
        var line = ""
        for (word in text.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
            val next = if (line.isEmpty()) word else "$line $word"
            if (line.isNotEmpty() && measure(next) > maxWidth) {
                lines += line
                line = word
            } else {
                line = next
            }
        }
        if (line.isNotEmpty()) lines += line
        return lines
    }

    /** Draws wrapped lines from baseline [y]; returns the baseline after the last. */
    private fun lines(canvas: Canvas, text: String, x: Float, y: Float, maxW: Float, p: TextPaint, lineH: Float, max: Int): Float {
        val out = wrapWords(text, maxW) { p.measureText(it) }.take(max)
        out.forEachIndexed { i, l -> canvas.drawText(l, x, y + i * lineH, p) }
        return y + out.size * lineH
    }

    private fun background(canvas: Canvas, w: Int, h: Int, c: TrackColors) {
        canvas.drawColor(c.bgPage.toArgb())
        val glow = Paint().apply {
            shader = RadialGradient(
                w * 0.85f, 0f, maxOf(w, h) * 0.75f,
                c.accentTint.toArgb(), android.graphics.Color.TRANSPARENT, Shader.TileMode.CLAMP,
            )
        }
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), glow)
    }

    /** The app icon's lime tile with the chevron, as the web image draws it. */
    private fun mark(canvas: Canvas, x: Float, y: Float, s: Float, c: TrackColors) {
        canvas.drawRoundRect(RectF(x, y, x + s, y + s), s * 0.24f, s * 0.24f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = c.accent.toArgb() })
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = c.accentContrast.toArgb()
            style = Paint.Style.STROKE
            strokeWidth = s * 0.13f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        val path = android.graphics.Path().apply {
            moveTo(x + s * 0.4f, y + s * 0.28f)
            lineTo(x + s * 0.62f, y + s * 0.5f)
            lineTo(x + s * 0.4f, y + s * 0.72f)
        }
        canvas.drawPath(path, stroke)
    }

    private fun stats(data: Wrapped, units: UnitSystem): List<Pair<String, String>> {
        val t = data.totals
        val dist = WrappedStory.trackDistance(t.miles, units)
        return buildList {
            add(WrappedStory.fmtDays(t.trackDays) to WrappedStory.plural(t.trackDays, "track day"))
            add(WrappedStory.int(t.tracks.toDouble()) to WrappedStory.plural(t.tracks.toDouble(), "track"))
            add(WrappedStory.int(t.laps.toDouble()) to WrappedStory.plural(t.laps.toDouble(), "lap"))
            if (t.milesTracksCounted != 0) add(dist.value to dist.unit)
        }
    }

    private fun drawStory(canvas: Canvas, data: Wrapped, units: UnitSystem, c: TrackColors, f: Fonts) {
        val w = STORY_W.toFloat()
        val h = STORY_H.toFloat()
        val pad = 96f
        val p = WrappedStory.posterLines(data, units)
        mark(canvas, pad, pad, 76f, c)
        canvas.drawText("Track Evolution", pad + 100f, pad + 52f, paint(f, 40f, 600, c.textStrong.toArgb()))
        canvas.drawText("SEASON WRAPPED", pad, 290f, paint(f, 32f, 600, c.accentInk.toArgb(), 0.12f))
        var y = lines(canvas, p.title, pad, 390f, w - pad * 2, paint(f, 92f, 600, c.textStrong.toArgb()), 104f, 3)

        // Budgeted like the web image: 2 × 210 of numbers, then ~130 a row
        // (~180 when it wraps), so four rows fit above the footer.
        y += 50f
        val colW = (w - pad * 2) / 2
        stats(data, units).forEachIndexed { i, (value, label) ->
            val cx = pad + (i % 2) * colW
            val cy = y + (i / 2) * 210f
            val big = paint(f, 140f, 600, c.accentInk.toArgb())
            while (big.textSize > 70f && big.measureText(value) > colW - 30f) big.textSize -= 10f
            canvas.drawText(value, cx, cy + 130f, big)
            canvas.drawText(label, cx, cy + 180f, paint(f, 38f, 400, c.textMuted.toArgb()))
        }
        y += ((stats(data, units).size + 1) / 2) * 210f + 40f
        canvas.drawRect(pad, y, w - pad, y + 2f, Paint().apply { color = c.borderHairline.toArgb() })
        y += 70f
        for ((label, value) in p.rows) {
            if (y > h - 230f) break
            canvas.drawText(label, pad, y, paint(f, 32f, 400, c.textMuted.toArgb()))
            y = lines(canvas, value, pad, y + 56f, w - pad * 2, paint(f, 44f, 600, c.textStrong.toArgb()), 52f, 2) + 22f
        }
        canvas.drawText("trackevolution.app", pad, h - pad, paint(f, 36f, 500, c.textMuted.toArgb()))
    }

    private fun drawWide(canvas: Canvas, data: Wrapped, units: UnitSystem, c: TrackColors, f: Fonts) {
        val w = WIDE_W.toFloat()
        val h = WIDE_H.toFloat()
        val pad = 64f
        val p = WrappedStory.posterLines(data, units)
        mark(canvas, pad, pad, 52f, c)
        canvas.drawText("Track Evolution", pad + 70f, pad + 36f, paint(f, 28f, 600, c.textStrong.toArgb()))
        val leftW = 560f
        var y = lines(canvas, p.title, pad, 210f, leftW, paint(f, 54f, 600, c.textStrong.toArgb()), 62f, 3)
        lines(canvas, p.headline.joinToString(" · "), pad, y + 40f, leftW, paint(f, 28f, 500, c.accentInk.toArgb()), 38f, 3)
        val rx = pad + leftW + 60f
        val rw = w - rx - pad
        var ry = 130f
        for ((label, value) in p.rows) {
            if (ry > h - 90f) break
            canvas.drawText(label, rx, ry, paint(f, 22f, 400, c.textMuted.toArgb()))
            ry = lines(canvas, value, rx, ry + 38f, rw, paint(f, 30f, 600, c.textStrong.toArgb()), 36f, 2) + 24f
        }
        canvas.drawText("trackevolution.app", pad, h - pad + 8f, paint(f, 24f, 500, c.textMuted.toArgb()))
    }
}
