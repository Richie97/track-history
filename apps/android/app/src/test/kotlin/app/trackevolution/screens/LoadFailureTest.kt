package app.trackevolution.screens

import app.trackevolution.core.api.ApiClient
import app.trackevolution.ui.LoadState
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

/**
 * A screen whose load fails says so — it does not crash the app.
 *
 * Each of these models fetches in parallel with `async` inside `scope.launch`.
 * Written without a `coroutineScope` around them, a failed fetch cancels the
 * launch before the `try`'s catch can matter and reaches the scope's uncaught
 * handler, which on the real `viewModelScope` takes the process down: the
 * Garage tab crashed that way on a tablet whose dev server wasn't running.
 * The handler here records instead of crashing, so the test can say which.
 */
class LoadFailureTest {

    private fun failingApi(): ApiClient {
        val engine = MockEngine {
            respond("""{"error":"boom"}""", HttpStatusCode.InternalServerError, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return ApiClient(engine, baseUrl = "https://example.test")
    }

    private fun assertFailsQuietly(build: (CoroutineScope, ApiClient) -> Pair<() -> Unit, () -> LoadState>) {
        val uncaught = Collections.synchronizedList(mutableListOf<Throwable>())
        val scope = CoroutineScope(
            SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, e -> uncaught += e },
        )
        try {
            val (load, state) = build(scope, failingApi())
            load()
            runBlocking {
                withTimeout(5_000) {
                    while (state() == LoadState.Loading && uncaught.isEmpty()) delay(10)
                }
            }
            assertEquals("uncaught: $uncaught", emptyList<Throwable>(), uncaught.toList())
            assertTrue("state was ${state()}", state() is LoadState.Failed)
        } finally {
            scope.cancel()
        }
    }

    @Test fun garage() = assertFailsQuietly { s, api -> GarageModel(s, api).let { it::load to { it.state } } }

    @Test fun dashboard() = assertFailsQuietly { s, api -> DashboardModel(s, api).let { it::load to { it.state } } }

    @Test fun vehicle() = assertFailsQuietly { s, api -> VehicleModel(s, api, 1).let { it::load to { it.state } } }

    @Test fun event() = assertFailsQuietly { s, api -> EventModel(s, api, 1).let { it::load to { it.state } } }

    @Test fun eventForm() = assertFailsQuietly { s, api -> EventFormModel(s, api).let { it::load to { it.state } } }

    @Test fun track() = assertFailsQuietly { s, api -> TrackModel(s, api, 1).let { it::load to { it.state } } }

    @Test fun leaderboard() = assertFailsQuietly { s, api -> LeaderboardModel(s, api, 1).let { it::load to { it.state } } }

    @Test fun coaching() = assertFailsQuietly { s, api -> CoachingModel(s, api).let { it::load to { it.state } } }

    @Test fun studentHome() = assertFailsQuietly { s, api -> StudentHomeModel(s, api).let { it::load to { it.state } } }
}
