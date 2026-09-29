package app.trackevolution.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import app.trackevolution.core.Profile
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.navigation.SavedState
import app.trackevolution.ui.LoadState
import app.trackevolution.ui.TEConfirmDialog
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEField
import app.trackevolution.ui.TELoadable
import app.trackevolution.ui.TESectionHeader
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The driver-profile form (NS-38), built from `Profile.PROFILE_GROUPS` —
 * `viewProfile` in `public/app.js`.
 *
 * **The draft survives a configuration change and process death**, the event
 * form's rule: the model lives on the back stack entry, and every field writes
 * through to the [SavedStateHandle] as the raw string the form shows. The
 * `hydrated` flag is what stops a load finishing after a restore from
 * overwriting what was typed with the server's copy.
 *
 * Validation is the server's; a 400 names the rule that failed and is shown as
 * it is. Every yes/no is a three-way choice, so an unanswered one stays null
 * rather than reading "No".
 */
class ProfileFormModel(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    private val saved: SavedStateHandle? = null,
) {
    var state by mutableStateOf<LoadState>(LoadState.Loading)
        private set

    /** The form's raw values, by wire key — what `profileBody` reads. */
    private val values = mutableStateMapOf<String, String>().apply {
        for (f in Profile.PROFILE_FIELDS) saved?.get<String>(key(f.key))?.let { put(f.key, it) }
    }

    private var hydrated by SavedState(saved, "hydrated", false)

    /** Whether there is a stored profile to clear. */
    var hasProfile by SavedState(saved, "hasProfile", false)
        private set

    var saving by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var savedOk by mutableStateOf(false)
        private set

    fun value(key: String): String = values[key].orEmpty()

    fun set(key: String, value: String) {
        values[key] = value
        saved?.set(key(key), value)
    }

    fun load() {
        if (hydrated) {
            state = LoadState.Ready
            return
        }
        scope.launch {
            try {
                val me = api.profile()
                // Checked again: a restore may have hydrated while this was in flight.
                if (!hydrated) {
                    Profile.formValues(me.profile).forEach { (k, v) -> set(k, v) }
                    hasProfile = me.profile != null
                    hydrated = true
                }
                state = LoadState.Ready
            } catch (e: ApiException) {
                state = LoadState.Failed(e.message)
            }
        }
    }

    fun save() = write(clear = false)

    fun clear() = write(clear = true)

    private fun write(clear: Boolean) {
        if (saving) return
        scope.launch {
            saving = true
            error = null
            try {
                val stored = api.updateProfile(if (clear) null else Profile.profileBody(values.toMap())).profile
                // Back from the server trimmed, so the form shows what was kept.
                Profile.formValues(stored).forEach { (k, v) -> set(k, v) }
                hasProfile = stored != null
                savedOk = true
            } catch (e: ApiException) {
                error = e.message
            } finally {
                saving = false
            }
        }
    }

    private fun key(field: String) = "pf-$field"
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileFormScreen(
    model: ProfileFormModel,
    onSaved: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    var confirmClear by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { if (model.state == LoadState.Loading) model.load() }
    LaunchedEffect(model.savedOk) { if (model.savedOk) onSaved() }

    TELoadable(state = model.state, onRetry = model::load, modifier = modifier) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("profileForm"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
        ) {
            item("title") {
                Column {
                    Text("Driver profile", style = TrackTheme.typography.h1, color = colors.textStrong)
                    Text(
                        "What the coaches you've invited see about you. Only you and them — it's never on your " +
                            "share page or the leaderboards. There's no birth date or emergency contact here on " +
                            "purpose: tell your instructor those at the track.",
                        style = TrackTheme.typography.sm,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            Profile.PROFILE_GROUPS.forEach { group ->
                item("group-${group.title}") {
                    TrackCard(Modifier.fillMaxWidth()) {
                        TESectionHeader(group.title)
                        group.fields.forEach { field ->
                            ProfileField(field, model.value(field.key)) { model.set(field.key, it) }
                        }
                    }
                }
            }
            item("save") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TEErrorBanner(model.error)
                    Button(
                        onClick = model::save,
                        enabled = !model.saving,
                        modifier = Modifier.fillMaxWidth().testTag("saveProfile"),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.accent,
                            contentColor = colors.accentContrast,
                        ),
                    ) {
                        Text(if (model.saving) "Saving…" else "Save profile", style = TrackTheme.typography.bodyStrong)
                    }
                    if (model.hasProfile) {
                        TextButton(onClick = { confirmClear = true }) {
                            Text("Clear profile", style = TrackTheme.typography.sm, color = colors.danger)
                        }
                    }
                }
            }
        }
    }

    if (confirmClear) {
        TEConfirmDialog(
            text = "Clear your whole driver profile?",
            confirm = "Clear",
            onConfirm = { confirmClear = false; model.clear() },
            onDismiss = { confirmClear = false },
        )
    }
}

/**
 * One field by its kind. A select and a yes/no are rows of choices rather than
 * drop-downs: a handful of options reads at a glance, and "—" (not said) is
 * always one of them.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProfileField(field: Profile.Field, value: String, onChange: (String) -> Unit) {
    TEField(field.label, modifier = Modifier.padding(top = 10.dp)) {
        when (field.kind) {
            Profile.Kind.SELECT, Profile.Kind.BOOL -> {
                val options = listOf("" to "—") + (
                    if (field.kind == Profile.Kind.BOOL) listOf("yes" to "Yes", "no" to "No") else field.options.orEmpty()
                    )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    options.forEach { (v, label) -> Choice(label, selected = v == value, tag = "pf-${field.key}-$v") { onChange(v) } }
                }
            }
            else -> OutlinedTextField(
                value = value,
                onValueChange = { next ->
                    val max = field.max
                    if (field.kind == Profile.Kind.YEAR) {
                        if (next.length <= 4 && next.all(Char::isDigit)) onChange(next)
                    } else if (max == null || next.length <= max) {
                        onChange(next)
                    }
                },
                placeholder = field.placeholder?.let { { Text(it, style = TrackTheme.typography.sm) } },
                singleLine = field.kind != Profile.Kind.LONG,
                minLines = if (field.kind == Profile.Kind.LONG) 3 else 1,
                keyboardOptions = if (field.kind == Profile.Kind.YEAR) {
                    KeyboardOptions(keyboardType = KeyboardType.Number)
                } else {
                    KeyboardOptions.Default
                },
                modifier = Modifier.fillMaxWidth().testTag("pf-${field.key}"),
            )
        }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    val colors = TrackTheme.colors
    TrackCard(
        modifier = Modifier
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }
            .testTag(tag),
        border = if (selected) colors.accent else colors.borderHairline,
        contentPadding = 8.dp,
    ) {
        Text(label, style = TrackTheme.typography.sm, color = if (selected) colors.accentInk else colors.textMuted)
    }
}
