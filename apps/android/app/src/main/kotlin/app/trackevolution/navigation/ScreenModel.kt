package app.trackevolution.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CoroutineScope

/**
 * Holds one screen's model for as long as its destination is on the back stack.
 *
 * A plain `remember` is not enough: it is discarded on a configuration change, so
 * rotating the phone would re-fetch the screen and — worse — throw away whatever
 * was half-typed into the event form. A `ViewModel` scoped to the
 * `NavBackStackEntry` survives rotation, theme changes and font-scale changes,
 * and is cleared exactly when the destination is popped.
 *
 * The models themselves know nothing about this: they take a [CoroutineScope],
 * and [viewModelScope] is simply the one that is cancelled at the right moment.
 */
class ScreenModelHolder<T : Any>(
    handle: SavedStateHandle,
    factory: (CoroutineScope, SavedStateHandle) -> T,
) : ViewModel() {
    val model: T = factory(viewModelScope, handle)
}

/**
 * The model for the current destination, created once and kept across
 * configuration changes.
 *
 * [factory] is handed the scope to launch in and a [SavedStateHandle] for
 * anything that must also survive **process death** — the system killing the app
 * in the background is an ordinary event on Android, not an edge case, and a
 * half-filled event form is the one thing on these screens that cannot be
 * re-fetched.
 */
@Composable
inline fun <reified T : Any> rememberScreenModel(
    key: String? = null,
    crossinline factory: (CoroutineScope, SavedStateHandle) -> T,
): T {
    val holder = viewModel<ScreenModelHolder<T>>(key = key) {
        ScreenModelHolder(handle = createSavedStateHandle()) { scope, handle ->
            factory(scope, handle)
        }
    }
    return holder.model
}

/**
 * A Compose state that also writes through to a [SavedStateHandle].
 *
 * Reads and writes are ordinary `by` delegation, so a model using it looks like
 * any other; the difference is only visible after the system has killed and
 * restored the process, which is exactly when it matters.
 *
 * Only Bundle-representable values belong here — `String`, `Boolean`, numbers.
 * Anything richer is stored as the string it is spelled with on the wire.
 */
class SavedState<T>(
    private val handle: SavedStateHandle?,
    private val key: String,
    initial: T,
) : MutableState<T> {

    @Suppress("UNCHECKED_CAST")
    private val backing = mutableStateOf(
        if (handle != null && handle.contains(key)) handle.get<T>(key) as T else initial,
    )

    override var value: T
        get() = backing.value
        set(next) {
            backing.value = next
            handle?.set(key, next)
        }

    override fun component1(): T = value

    override fun component2(): (T) -> Unit = { value = it }
}
