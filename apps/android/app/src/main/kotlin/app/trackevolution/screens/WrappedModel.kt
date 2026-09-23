package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Wrapped
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Season Wrapped (NS-36): one season's numbers, fetched from
 * `GET /api/wrapped/:year`. The card rules are `:core`'s [app.trackevolution.core.WrappedStory];
 * this model only loads, and remembers which card is in view so a rotation or
 * a fold lands back on it.
 */
public class WrappedModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    year: Int,
) {
    public sealed interface Phase {
        public data object Loading : Phase
        public data class Ready(val data: Wrapped) : Phase
        /** A 404: the year has no track days. A page, not an error. */
        public data object Empty : Phase
        public data class Failed(val message: String) : Phase
    }

    public var year: Int by mutableIntStateOf(year)
        private set
    public var phase: Phase by mutableStateOf(Phase.Loading)
        private set

    /** The card in view. Here rather than in the composable so it outlives a configuration change. */
    public var index: Int by mutableIntStateOf(0)

    public fun load(year: Int = this.year) {
        if (year != this.year) index = 0
        this.year = year
        phase = Phase.Loading
        scope.launch {
            phase = try {
                Phase.Ready(api.wrapped(year))
            } catch (e: ApiException) {
                if (e.status == 404) Phase.Empty else Phase.Failed(e.message ?: "Couldn't load your season.")
            }
        }
    }
}
