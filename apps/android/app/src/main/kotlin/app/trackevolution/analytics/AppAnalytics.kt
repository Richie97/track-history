package app.trackevolution.analytics

import android.content.Context
import android.os.Bundle
import app.trackevolution.BuildConfig
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics

/**
 * Google Analytics for Firebase: which screens get used, and nothing else.
 *
 * The native half of what `public/js/analytics.js` does for the web, under the
 * same rule: a screen is reported by its **shape** — `"/event/:id"`, never an
 * id, a share slug, an invite token or anything typed — and the shapes are the
 * web's own paths, so one report counts a screen on all three clients
 * ([app.trackevolution.navigation.analyticsPath]). No user id or user property
 * is ever set, and the manifest switches off the advertising id, the Android id,
 * ad signals and the automatic screen report (which could only ever say
 * "MainActivity").
 *
 * Collection is off in the manifest and switched on here only when
 * [BuildConfig.ANALYTICS] says so — every release build, and a debug build only
 * when built with `-Pte.analytics=true` — so development and the test suites
 * never count. Every call is a no-op until [start] has found a configured
 * Firebase app, which is what keeps a build without `google-services.json`
 * working.
 */
object AppAnalytics {

    @Volatile
    private var firebase: FirebaseAnalytics? = null

    @Volatile
    private var lastScreen: String? = null

    /** Called once from `TrackEvolutionApp.onCreate`. */
    fun start(context: Context) {
        if (!BuildConfig.ANALYTICS) return
        if (FirebaseApp.getApps(context).isEmpty()) return
        firebase = FirebaseAnalytics.getInstance(context).also {
            it.setAnalyticsCollectionEnabled(true)
        }
    }

    /**
     * Report the screen now showing, by its shape. A repeat of the screen
     * already reported is dropped: a recomposition, a rotation or a pane switch
     * that lands on the same page is not a second view.
     */
    fun screen(path: String) {
        val analytics = firebase ?: return
        if (path == lastScreen) return
        lastScreen = path
        analytics.logEvent(
            FirebaseAnalytics.Event.SCREEN_VIEW,
            Bundle().apply {
                putString(FirebaseAnalytics.Param.SCREEN_NAME, path)
                // The class is the same single activity for every screen; the
                // shape is the useful dimension, so it is both.
                putString(FirebaseAnalytics.Param.SCREEN_CLASS, path)
            },
        )
    }
}
