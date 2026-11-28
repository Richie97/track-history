package app.trackevolution.ai

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.trackevolution.core.AICoach
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.ui.TEErrorBanner
import app.trackevolution.ui.TEProLocked
import app.trackevolution.ui.theme.TrackCard
import app.trackevolution.ui.theme.TrackTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Settings → AI assistants → AI Coach (#320): one key per provider, which one
 * the AI Coach uses, the model, and Verify / Forget — the web's
 * `drawAiCoachSettings`. Held by Settings' destination
 * (`rememberScreenModel(key = "ai-coach")`), so a rotation keeps a check in
 * flight. Verifying is `POST /api/ai/coach/verify`, live and never queued.
 */
class AICoachSettingsState(
    private val scope: CoroutineScope,
    private val api: ApiClient,
    val keys: AICoachKeys,
) {
    /** Per provider: a check in flight. */
    val checking = mutableStateMapOf<String, Boolean>()

    /** Per provider: the last refusal, in words. */
    val errors = mutableStateMapOf<String, String>()

    /** Which providers' model lists were re-read this visit — once each, on the field's first focus. */
    private val refreshed = mutableSetOf<String>()

    /** 401 from verify: the app session is gone. */
    var signedOut by mutableStateOf(false)
        private set

    fun verify(provider: String, key: String) {
        val typed = key.trim()
        if (typed.isEmpty() || checking[provider] == true) return
        checking[provider] = true
        errors.remove(provider)
        scope.launch {
            try {
                val verified = api.verifyAICoachKey(provider, typed)
                keys.save(provider, typed, verified.models, verified.defaultModel)
            } catch (e: ApiException) {
                when {
                    e.isUnauthorized -> signedOut = true
                    e is ApiException.Transport -> errors[provider] = "Checking a key ${AICoach.COACH_OFFLINE}."
                    else -> errors[provider] = AICoach.coachErrorText(e.status ?: 0, e.message, provider)
                }
            } finally {
                checking[provider] = false
            }
        }
    }

    /** Re-reads the models a key can use, so one released since is there to pick; a failure leaves the stored list. */
    fun refreshModels(provider: String) {
        if (!refreshed.add(provider)) return
        val entry = keys.state.value.keys[provider] ?: return
        scope.launch {
            runCatching { api.verifyAICoachKey(provider, entry.key) }
                .onSuccess { keys.setModels(provider, entry.key, it.models, it.defaultModel) }
        }
    }
}

@Composable
fun AICoachSettingsCard(
    state: AICoachSettingsState,
    pro: Boolean,
    onSubscribe: () -> Unit,
    onOpenLink: (String) -> Unit,
    /** Debug builds pointed at a dev server: offer the server's scripted provider. */
    offerFake: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    if (!pro) {
        TEProLocked(title = AICoach.COACH_NAME, blurb = AICoach.COACH_PRO_WHAT, onSubscribe = onSubscribe, modifier = modifier)
        return
    }
    val keys by state.keys.state.collectAsState()
    TrackCard(modifier.fillMaxWidth().testTag("aiCoachSettings")) {
        Text(
            "A debrief of a session, two laps or a track day, on your own Anthropic, OpenAI or Google Gemini account.",
            style = type.sm,
            color = colors.textMuted,
        )
        AICoach.COACH_PROVIDERS.forEach { p ->
            HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(vertical = 12.dp))
            ProviderRow(state, p, keys, onOpenLink)
        }
        if (offerFake) {
            HorizontalDivider(color = colors.borderHairline, modifier = Modifier.padding(vertical = 12.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.testTag("aiCoachFake").toggleable(
                    value = keys.fake,
                    role = Role.Switch,
                    onValueChange = state.keys::setFake,
                ),
            ) {
                Switch(checked = keys.fake, onCheckedChange = null)
                Text("Use the dev server's fake provider", style = type.sm, color = colors.textBody)
            }
        }
        Text(
            "Your key is stored on this device only, encrypted, and sent with each ${AICoach.COACH_NAME} request — " +
                "it is never stored on our servers, and it is left out of backups. You pay Anthropic, OpenAI or Google " +
                "directly for what the ${AICoach.COACH_NAME} uses. ${AICoach.COACH_GEMINI_NOTE}",
            style = type.xs,
            color = colors.textFaint,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@Composable
private fun ProviderRow(
    state: AICoachSettingsState,
    p: AICoach.Provider,
    keys: AICoachKeysState,
    onOpenLink: (String) -> Unit,
) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    val entry = keys.keys[p.id]
    val active = keys.activeId == p.id
    Column(Modifier.testTag("aiProvider-${p.id}"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().selectable(
                selected = active,
                enabled = entry != null,
                role = Role.RadioButton,
                onClick = { state.keys.setActive(p.id) },
            ),
        ) {
            RadioButton(selected = active, onClick = null, enabled = entry != null)
            Column(Modifier.padding(start = 4.dp)) {
                Text(p.name, style = type.bodyStrong, color = colors.textStrong)
                Text(
                    if (entry != null) "key ${AICoachKeys.maskKey(entry.key)} · stored on this device only" else "no key yet",
                    style = type.xs,
                    color = colors.textMuted,
                )
            }
        }
        if (entry != null) {
            ModelField(state, p, entry)
            TextButton(onClick = { state.keys.forget(p.id) }, modifier = Modifier.testTag("aiForget-${p.id}")) {
                Text("Forget key", style = type.sm, color = colors.danger)
            }
        } else {
            // Plain `remember`, never saveable: a key must not go into the saved-instance Bundle.
            var typed by remember(p.id) { mutableStateOf("") }
            OutlinedTextField(
                value = typed,
                onValueChange = { typed = it },
                placeholder = { Text(p.placeholder, style = type.sm) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("aiKey-${p.id}"),
                textStyle = type.sm,
                label = { Text("${p.name} API key", style = type.xs) },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = { state.verify(p.id, typed) },
                    enabled = typed.isNotBlank() && state.checking[p.id] != true,
                    modifier = Modifier.testTag("aiVerify-${p.id}"),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentContrast),
                ) {
                    Text(if (state.checking[p.id] == true) "Checking…" else "Verify", style = type.bodyStrong)
                }
                TextButton(onClick = { onOpenLink(p.keyUrl) }) {
                    Text("Get a key ↗", style = type.sm, color = colors.textMuted)
                }
            }
        }
        state.errors[p.id]?.let { TEErrorBanner(it, Modifier.testTag("aiError-${p.id}")) }
    }
}

/**
 * The model: a type-ahead, not a closed picker. It offers the models the
 * provider's own list gave for this key, by id with the name beside it,
 * accepts an id that is not listed, and empty means the default. The first
 * focus re-reads the list.
 */
@Composable
private fun ModelField(state: AICoachSettingsState, p: AICoach.Provider, entry: AICoachKey) {
    val colors = TrackTheme.colors
    val type = TrackTheme.typography
    var text by remember(p.id, entry.key) { mutableStateOf(entry.model ?: "") }
    var focused by remember { mutableStateOf(false) }
    val commit = {
        val picked = AICoach.resolveModelInput(text, entry.models)
        text = picked ?: ""
        state.keys.setModel(p.id, picked)
    }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text("Model", style = type.xs) },
        placeholder = { Text(AICoach.modelPlaceholder(entry.defaultModel), style = type.sm) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { commit() }),
        textStyle = type.sm,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("aiModel-${p.id}")
            .onFocusChanged {
                if (it.isFocused) state.refreshModels(p.id)
                if (focused && !it.isFocused) commit()
                focused = it.isFocused
            },
    )
    if (focused) {
        val q = text.trim().lowercase()
        val matches = entry.models
            .filter { q.isEmpty() || it.id.lowercase().contains(q) || it.label.lowercase().contains(q) }
            .take(6)
        Column(Modifier.testTag("aiModels-${p.id}")) {
            matches.forEach { m ->
                Row(
                    Modifier.fillMaxWidth().clickable {
                        text = m.id
                        commit()
                    }.padding(vertical = 6.dp),
                ) {
                    Text(m.id, style = type.sm, color = colors.textStrong, modifier = Modifier.weight(1f))
                    if (m.label != m.id) Text(m.label, style = type.xs, color = colors.textMuted)
                }
            }
        }
    }
    Text(
        "Start typing to pick from the models your ${p.name} account offers, or leave it empty for the default.",
        style = type.xxs,
        color = colors.textFaint,
    )
}
