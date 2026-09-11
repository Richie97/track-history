package app.trackevolution.billing

/**
 * The reconnect schedule after Play's billing service drops the connection
 * (`SERVICE_DISCONNECTED`): doubling from one second, capped at a minute.
 *
 * Play's own guidance is "reconnect with exponential backoff"; the cap keeps a
 * device with Play Services misbehaving from waking every few seconds forever,
 * and a successful connection resets the attempt count.
 */
object Backoff {
    private const val FIRST_MS = 1_000L
    private const val CAP_MS = 60_000L

    fun delayMs(attempt: Int): Long = (FIRST_MS shl attempt.coerceIn(0, 6)).coerceAtMost(CAP_MS)
}
