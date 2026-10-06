package app.trackevolution.screens

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.trackevolution.auth.CustomTabs
import app.trackevolution.ui.TEEmpty
import app.trackevolution.ui.TERetryButton
import app.trackevolution.ui.theme.TrackTheme

/**
 * *Your first track day* — `site/docs/track-days.html` — read inside the app
 * rather than in a browser tab, from the dashboard's first-run card and from
 * Settings. iOS's `TrackDaysGuideScreen`.
 *
 * The page is the docs site's, so the organizer list stays maintained in one
 * place. What the app changes is the frame ([GuidePage]): the site's header,
 * sidebar, pager and footer are hidden, since this screen and the system back
 * gesture do their job, and the web view marks its user agent so
 * `site/analytics.js` loads nothing — the app reports this screen by its route
 * like any other. A link off the docs site, which is every organizer's, opens
 * in a Custom Tab: those are sites to sign up on.
 */
@Composable
fun TrackDaysGuideScreen(modifier: Modifier = Modifier) {
    val colors = TrackTheme.colors
    var loading by remember { mutableStateOf(true) }
    var failure by remember { mutableStateOf<String?>(null) }
    // Bumped by Try again, which builds a fresh web view.
    var attempt by remember { mutableIntStateOf(0) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }

    // Back walks the guide's own history first — a docs link followed from it —
    // and only then leaves the screen.
    BackHandler(enabled = canGoBack && failure == null) { webView?.goBack() }

    // No heading of its own: the page opens with one.
    Column(modifier = modifier.fillMaxSize()) {
        val error = failure
        if (error != null) {
            Column(Modifier.padding(16.dp)) {
                TEEmpty(error, title = "Couldn't open the guide")
                TERetryButton(onClick = {
                    failure = null
                    loading = true
                    attempt++
                })
            }
            return@Column
        }
        Box(Modifier.fillMaxSize()) {
            key(attempt) {
                GuideWebView(
                    background = colors.bgPage.toArgb(),
                    onCreated = { webView = it },
                    onLoading = { loading = it },
                    onHistory = { canGoBack = it },
                    onFailure = { failure = it },
                )
            }
            if (loading) {
                CircularProgressIndicator(
                    color = colors.accent,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .semantics { contentDescription = "Loading the guide" },
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun GuideWebView(
    background: Int,
    onCreated: (WebView) -> Unit,
    onLoading: (Boolean) -> Unit,
    onHistory: (Boolean) -> Unit,
    onFailure: (String) -> Unit,
) {
    AndroidView(
        modifier = Modifier
            .fillMaxSize()
            .semantics { testTag = "trackDaysGuideWeb" },
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(background)
                // The page's own scripts, and the style this screen adds to it.
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.userAgentString = "${settings.userAgentString} ${GuidePage.USER_AGENT_MARK}"
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        if (GuidePage.opensInApp(request.url)) return false
                        CustomTabs.open(view.context, request.url.toString())
                        return true
                    }

                    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                        onLoading(true)
                    }

                    // Before the page is first drawn, so the site's header never
                    // flashes in and out.
                    override fun onPageCommitVisible(view: WebView, url: String?) {
                        view.evaluateJavascript(GuidePage.CHROME_SCRIPT, null)
                    }

                    override fun onPageFinished(view: WebView, url: String?) {
                        view.evaluateJavascript(GuidePage.CHROME_SCRIPT, null)
                        onLoading(false)
                    }

                    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                        onHistory(view.canGoBack())
                    }

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        // Only the page itself not arriving is news; a stylesheet
                        // or an image that fails is the page's problem to draw.
                        if (!request.isForMainFrame) return
                        onLoading(false)
                        onFailure(GuidePage.failureText(error.errorCode))
                    }
                }
                onCreated(this)
                loadUrl(TRACK_DAYS_GUIDE_URL)
            }
        },
    )
}

/**
 * The rules the guide's web view follows, apart from the WebView so they can be
 * tested — iOS's `GuidePage` carries the same ones.
 */
internal object GuidePage {
    /** Appended to the web view's user agent; `site/analytics.js` reads it. */
    const val USER_AGENT_MARK = "TrackEvolution-App"

    /** The site chrome the screen replaces. */
    const val HIDDEN_CHROME = ".site-header, .docs-sidebar, .docs-pager, .site-footer, .consent-banner"

    /**
     * iOS's `chromeScript`, verbatim. Idempotent: it runs on commit and again on
     * finish, and adds its style once; and it waits for an `<html>` rather than
     * assuming one.
     */
    const val CHROME_SCRIPT = """
        (function () {
          function add() {
            if (document.getElementById("te-app-frame")) return true;
            var root = document.head || document.documentElement;
            if (!root) return false;
            var s = document.createElement("style");
            s.id = "te-app-frame";
            s.textContent = "$HIDDEN_CHROME { display: none !important; } .docs-layout { padding-top: 20px; }";
            root.appendChild(s);
            return true;
          }
          if (!add()) new MutationObserver(function (_, o) { if (add()) o.disconnect(); })
            .observe(document, { childList: true, subtree: true });
        })();
    """

    private val GUIDE_HOST: String = Uri.parse(TRACK_DAYS_GUIDE_URL).host.orEmpty()

    /**
     * Whether a link stays in the web view: the docs site's own pages do,
     * anything else — an organizer, a store listing, a mail link — leaves.
     */
    fun opensInApp(url: Uri): Boolean = url.scheme == "https" && url.host == GUIDE_HOST

    /** What the screen says when the page doesn't arrive. */
    fun failureText(errorCode: Int): String = when (errorCode) {
        WebViewClient.ERROR_HOST_LOOKUP, WebViewClient.ERROR_CONNECT, WebViewClient.ERROR_TIMEOUT ->
            "The guide is on the web, so it needs a connection. Try again once you have signal."
        else -> "The page didn't load. Try again in a moment."
    }
}
