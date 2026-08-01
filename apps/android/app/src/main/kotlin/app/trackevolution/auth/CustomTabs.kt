package app.trackevolution.auth

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Opens the authorization URL **in the system browser**.
 *
 * A Chrome Custom Tab, never a `WebView`: Google blocks OAuth in embedded web
 * views outright, and that block is the reason the server grew a PKCE
 * native-app flow at all. The tab also shares the browser's cookie jar, which is
 * the difference between a two-tap sign-in for someone already signed in to
 * Google and retyping a password.
 *
 * Falls back to `ACTION_VIEW` when no Custom Tabs provider is installed — a
 * plain browser is a worse experience but still a *system* browser, so the flow
 * completes. Returns false only when the device has no browser at all, which the
 * caller surfaces rather than leaving a dead button.
 *
 * **[context] must be an Activity.** Launching from the application context
 * throws unless `FLAG_ACTIVITY_NEW_TASK` is set, and setting that flag would be
 * the wrong fix: the tab belongs on top of *our* task, so that dismissing it or
 * following the redirect comes back to the activity that started the flow rather
 * than to a second task standing beside it.
 */
object CustomTabs {

    fun open(context: Context, url: String): Boolean {
        val uri = Uri.parse(url)
        return try {
            CustomTabsIntent.Builder()
                .setShowTitle(false)
                .setUrlBarHidingEnabled(true)
                .build()
                .launchUrl(context, uri)
            true
        } catch (_: ActivityNotFoundException) {
            openInBrowser(context, uri)
        }
    }

    private fun openInBrowser(context: Context, uri: Uri): Boolean = try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}
