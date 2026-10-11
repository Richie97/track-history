package app.trackevolution.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.Garage
import app.trackevolution.core.Units
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.Part
import app.trackevolution.core.model.SetupSheet
import app.trackevolution.core.model.UnitSystem
import app.trackevolution.navigation.SavedState
import app.trackevolution.ui.LoadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * One day's setup sheet, logged or edited on the phone (NS-40) — the web's
 * `setupFormHtml` / `readSetupForm` as a destination of its own, never a dialog
 * (a text field in an `AlertDialog` never lets Robolectric idle, and a form this
 * long does not belong in one).
 *
 * **The draft is the typed text**, in the driver's units: [values] maps each
 * flat key ("tp_cold.fl", "fuel") to what is in its field. It is converted to
 * stored psi and gallons only on [save] (`Garage.setupToStored`), so a half-typed
 * "2.1" survives a rotation as typed, and it lives in the [SavedStateHandle] —
 * the system killing the app between sessions is ordinary, and the sheet is the
 * one thing on this screen that cannot be re-fetched. [hydrated] is the event
 * form's rule: once filled, a later load never overwrites the draft.
 *
 * Where the draft starts, in order: a restored draft; [startFrom], the pressure
 * loop's next-day sheet; the day's own sheet; the server's copy-forward prefill
 * (`GET /events/:id/setups/prefill`); and, offline with nothing cached,
 * `Garage.previousSheet` over the cached event — the first half of the server's
 * rule.
 */
class SetupFormModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val eventId: Int,
    val day: Int,
    private val startFrom: SetupSheet? = null,
    private val units: UnitSystem = Units.DEFAULT_UNITS,
    private val saved: SavedStateHandle? = null,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    /** Where the draft came from, said under the title: "Copied from day 1". */
    var source by mutableStateOf<String?>(null)
        private set

    /** Whether the day already has a sheet — what offers *Delete*. */
    var existing by mutableStateOf(false)
        private set

    /** The event's car's parts, for the tire and pad pickers; empty hides them. */
    var parts by mutableStateOf<List<Part>>(emptyList())
        private set

    var error by mutableStateOf<String?>(null)
        private set

    var saving by mutableStateOf(false)
        private set

    /** True once a save or delete went through, so the screen pops. */
    var done by mutableStateOf(false)
        private set

    private var valuesJson by SavedState(saved, "setupValues", "{}")
    var notes by SavedState(saved, "setupNotes", "")
    private var hydrated by SavedState(saved, "hydrated", false)

    private val codec = MapSerializer(String.serializer(), String.serializer())

    /** The typed text per flat key, in the driver's units. */
    val values: Map<String, String>
        get() = runCatching { Json.decodeFromString(codec, valuesJson) }.getOrDefault(emptyMap())

    fun setValue(key: String, text: String) {
        valuesJson = Json.encodeToString(codec, values + (key to text))
    }

    fun load() {
        scope.launch {
            try {
                val detail = api.event(eventId)
                existing = detail.setups.any { it.day == day }
                parts = runCatching {
                    api.garage().firstOrNull { it.id == detail.event.vehicleId }?.parts.orEmpty()
                }.getOrDefault(emptyList())
                if (!hydrated) {
                    val own = detail.setups.firstOrNull { it.day == day }?.data
                    val start = when {
                        startFrom != null -> startFrom.also { source = "Suggested cold pressures from the pressure loop" }
                        own != null -> own
                        else -> prefill(detail.setups)
                    }
                    fill(start)
                    hydrated = true
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message ?: "Couldn't load this event.")
            }
        }
    }

    /**
     * The server's copy-forward prefill, else — offline, or a server that can't
     * be reached — the latest earlier day's sheet from the cached event.
     */
    private suspend fun prefill(setups: List<app.trackevolution.core.model.Setup>): SetupSheet? {
        val local = Garage.previousSheet(setups, day)
        return try {
            api.setupPrefill(eventId, day)?.also {
                source = if (local != null && it == local) "Copied from day ${dayOf(setups, local)}" else "Copied from your last event in this car"
            }
        } catch (_: ApiException) {
            local?.also { source = "Copied from day ${dayOf(setups, it)}" }
        }
    }

    private fun dayOf(setups: List<app.trackevolution.core.model.Setup>, sheet: SetupSheet): Int =
        setups.lastOrNull { it.day < day && it.data == sheet }?.day ?: (day - 1)

    /** The draft from a stored sheet: every value converted into the driver's units. */
    private fun fill(sheet: SetupSheet?) {
        val out = LinkedHashMap<String, String>()
        if (sheet != null) {
            for (field in Garage.SETUP_FIELDS) {
                for (key in Garage.flatKeys(field)) {
                    Garage.setupToDisplay(field, Garage.sheetValue(sheet, key), units)?.let { out[key] = Units.jsNumber(it) }
                }
            }
            for (ref in Garage.PART_REFS) Garage.partRefValue(sheet, ref.key)?.let { out[ref.key] = it.toString() }
        }
        valuesJson = Json.encodeToString(codec, out)
        notes = sheet?.notes.orEmpty()
    }

    /**
     * The sheet the draft spells, in stored units — or null with [error] set when
     * a field doesn't read as a number. A comma reads as a decimal point, since
     * that is what a European keyboard types.
     */
    fun sheet(): SetupSheet? {
        var out = SetupSheet()
        for (field in Garage.SETUP_FIELDS) {
            for (key in Garage.flatKeys(field)) {
                val text = values[key]?.trim()?.replace(',', '.').orEmpty()
                if (text.isEmpty()) continue
                val v = text.toDoubleOrNull()
                if (v == null || !v.isFinite()) {
                    error = "Couldn't read ${Garage.flatLabel(key)} \"$text\"."
                    return null
                }
                out = Garage.withSheetValue(out, key, Garage.setupToStored(field, v, units))
            }
        }
        for (ref in Garage.PART_REFS) {
            values[ref.key]?.toIntOrNull()?.let { out = Garage.withSheetValue(out, ref.key, it.toDouble()) }
        }
        return out.copy(notes = notes.trim().takeIf { it.isNotEmpty() })
    }

    fun save() {
        error = null
        val sheet = sheet() ?: return
        if (Garage.isEmptySheet(sheet)) {
            error = if (existing) "Nothing is recorded — delete the sheet instead." else "Nothing is recorded yet."
            return
        }
        saving = true
        scope.launch {
            try {
                api.putSetup(eventId, day, sheet)
                done = true
            } catch (e: ApiException) {
                error = e.message
            }
            saving = false
        }
    }

    fun delete() {
        error = null
        saving = true
        scope.launch {
            try {
                api.deleteSetup(eventId, day)
                done = true
            } catch (e: ApiException) {
                error = e.message
            }
            saving = false
        }
    }
}
