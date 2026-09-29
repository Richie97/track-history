package app.trackevolution.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * The modules of a QR code for [text], row by row — zxing's encoder, with no
 * margin (the composable draws the quiet zone) and medium error correction,
 * which is plenty for a screen held up to a camera. Null when the text cannot
 * be encoded, which for an invite URL means never.
 */
internal fun qrModules(text: String): List<BooleanArray>? = runCatching {
    val matrix = QRCodeWriter().encode(
        text,
        BarcodeFormat.QR_CODE,
        0,
        0,
        mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
    )
    (0 until matrix.height).map { y -> BooleanArray(matrix.width) { x -> matrix.get(x, y) } }
}.getOrNull()

/**
 * A coaching invite as a QR code (NS-38), for handing the link over in the
 * paddock: the coach points their camera at the driver's phone.
 *
 * **Always dark on white**, whatever the theme — a code drawn in the dark
 * theme's light-on-dark is inverted, and plenty of scanners refuse one. The
 * white box is the quiet zone the spec requires, four modules wide.
 */
@Composable
fun QrCode(text: String, modifier: Modifier = Modifier, size: Dp = 200.dp) {
    val modules = remember(text) { qrModules(text) } ?: return
    val count = modules.size
    Box(
        modifier
            .background(Color.White)
            .padding(size * (4f / (count + 8)))
            .semantics {
                contentDescription = "QR code for the invite link"
                testTag = "inviteQr"
            },
    ) {
        Canvas(Modifier.size(size * (count.toFloat() / (count + 8)))) {
            val cell = this.size.width / count
            // A hair of overlap so neighbouring modules never show a seam.
            val drawn = Size(cell + 0.5f, cell + 0.5f)
            modules.forEachIndexed { y, row ->
                row.forEachIndexed { x, on ->
                    if (on) drawRect(Color.Black, topLeft = Offset(x * cell, y * cell), size = drawn)
                }
            }
        }
    }
}
