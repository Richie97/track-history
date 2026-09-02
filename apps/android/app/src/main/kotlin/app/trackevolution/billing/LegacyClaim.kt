package app.trackevolution.billing

/**
 * The once-per-install grandfathering claim (NS-32 requirement 6): what the
 * server's answer to `POST /api/billing/google/legacy` means for whether to ask
 * again.
 *
 * Thirty-day sessions mean an already-signed-in user never re-exchanges a
 * code, so this runs from the app each time it becomes signed in — not from
 * `/auth/exchange` — and a persisted flag ([BillingPrefs.legacyClaimed]) stops
 * it once it has an answer.
 */
object LegacyClaim {

    enum class Outcome {
        /** 2xx: the server wrote (or already had) the `legacy` row. Done. */
        GRANTED,

        /**
         * A final no: `403 legacy claim window closed` (after `LEGACY_CUTOFF`)
         * or a 409. Asking again would get the same answer. Done.
         */
        DONE,

        /**
         * Try again next launch: no answer at all (offline), a 401 (the session
         * is gone — the next sign-in re-runs this), a 5xx, or a 400 — which is a
         * missing header, i.e. a bug worth keeping visible rather than burying
         * under a "claimed" flag.
         */
        RETRY,
    }

    fun outcome(status: Int?): Outcome = when {
        status == null -> Outcome.RETRY
        status in 200..299 -> Outcome.GRANTED
        status == 403 || status == 409 -> Outcome.DONE
        else -> Outcome.RETRY
    }
}
