package app.trackevolution.billing

/**
 * `X-TE-Client: android/<versionCode>` — how the transitional build identifies
 * itself on **every** request (NS-32 requirement 6).
 *
 * Play cannot tell a client whether the app was bought, so grandfathering the
 * $1 buyers on Android works by trust for a window: a build carrying this header
 * calls `POST /api/billing/google/legacy` once per install and the server writes
 * a `legacy` row for any such call before `LEGACY_CUTOFF`. The header is added
 * where `ApiClient` is constructed ([app.trackevolution.data.AppServices]) so
 * `:core` never learns about `BuildConfig`.
 */
object ClientHeader {
    const val NAME = "X-TE-Client"

    fun value(versionCode: Int): String = "android/$versionCode"
}
