package app.trackevolution.navigation

import android.content.Context
import android.content.Intent

/**
 * Hands a link to the system share sheet (NS-26 requires `ACTION_SEND`).
 *
 * A real share sheet rather than the web app's copy-to-clipboard fallback:
 * sending a run-group organizer your times is the reason the share link exists,
 * and "copied" leaves the user to find somewhere to paste it.
 *
 * `createChooser` rather than the bare intent so there is always a sheet, even
 * on a device where one app has been made the default for `text/plain`.
 */
fun shareLink(context: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, url)
    }
    context.startActivity(Intent.createChooser(send, null))
}
