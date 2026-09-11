package app.trackevolution.data

import android.content.Context
import app.trackevolution.BuildConfig
import app.trackevolution.auth.AuthStore
import app.trackevolution.billing.BillingController
import app.trackevolution.billing.BillingPrefs
import app.trackevolution.billing.ClientHeader
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.offline.OfflineStore
import io.ktor.client.engine.okhttp.OkHttp

/**
 * The process-wide singletons: the database, the offline store, and the one
 * [ApiClient] everything talks through.
 *
 * **Why this exists rather than an `ApiClient` per screen.** `OfflineStore`
 * keeps the pending count and the flush lock in memory, and both are
 * load-bearing. Two stores over the same database would each believe the queue
 * was empty until they loaded it, and their flush locks would not see each
 * other — so a connectivity flap and a manual refresh could replay the same
 * queue concurrently and interleave writes, which is exactly the ordering
 * guarantee NS-22 is built to provide. The replay worker runs in the same
 * process as the UI and must therefore reach the *same* instance, not an
 * equivalent one.
 *
 * Held by [app.trackevolution.TrackEvolutionApp], which is the only thing whose
 * lifetime actually matches the process.
 */
internal class AppServices private constructor(context: Context) {

    private val db = OfflineDatabase.open(context)

    val authStore = AuthStore(context)

    private val offline = OfflineStore(RoomOfflinePersistence(db))

    /**
     * OkHttp is chosen here, not in `:core` — that is what keeps the pure module
     * free of an HTTP engine and testable on the JVM.
     */
    val api = ApiClient(
        OkHttp.create(),
        tokens = authStore,
        offline = offline,
        // `X-TE-Client: android/<versionCode>` on every request (NS-32 req. 6):
        // the transitional build's identification for the once-per-install
        // legacy claim. Added here so :core never sees BuildConfig.
        defaultHeaders = mapOf(ClientHeader.NAME to ClientHeader.value(BuildConfig.VERSION_CODE)),
    )

    val sync = SyncScheduler(context, api)

    /**
     * Play Billing. Process-wide for the same reason as the store above: it
     * queries purchases on every cold start and holds a purchase seen with no
     * session until sign-in, neither of which belongs to an activity.
     */
    val billing = BillingController(
        context,
        api = api,
        isSignedIn = { authStore.isSignedIn },
        prefs = BillingPrefs(context),
    )

    companion object {
        @Volatile
        private var instance: AppServices? = null

        fun get(context: Context): AppServices =
            instance ?: synchronized(this) {
                instance ?: AppServices(context.applicationContext).also { instance = it }
            }
    }
}
