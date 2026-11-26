package app.trackevolution.ai

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.trackevolution.auth.EncryptedPrefs
import app.trackevolution.core.AICoach
import app.trackevolution.core.model.AICoachModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One provider's verified key, the model picked for it, and the models its account lists. */
@Serializable
data class AICoachKey(
    val key: String,
    val model: String? = null,
    @SerialName("default_model") val defaultModel: String? = null,
    val models: List<AICoachModel> = emptyList(),
)

/** Everything the AI Coach's Settings block holds: one key per provider, and which one the AI Coach uses. */
@Serializable
data class AICoachKeysState(
    val active: String? = null,
    val keys: Map<String, AICoachKey> = emptyMap(),
    /**
     * Debug builds only: send `X-TE-AI-Provider: fake`, the server's scripted
     * provider — answered only under `DEV_MODE` on a dev host (`localhost`,
     * the emulator's `10.0.2.2`), so the flag unlocks nothing in production.
     * The web's `te-ai-fake`.
     */
    val fake: Boolean = false,
) {
    /** The chosen provider if it has a key, else whichever does — `activeId` in `js/ai-keys.js`. */
    val activeId: String?
        get() = active?.takeIf { keys.containsKey(it) }
            ?: AICoach.COACH_PROVIDERS.map { it.id }.firstOrNull { keys.containsKey(it) }
}

/** What a request is sent with. [key] is null for the fake provider. */
data class AICoachCredential(val provider: String, val key: String?, val model: String?)

/**
 * Where the AI Coach's provider keys live on Android (#320): an
 * `EncryptedSharedPreferences` file of its own (`ai_coach.xml`, under its own
 * AndroidKeyStore master key), **on this device only**. Never on our servers —
 * a key is sent with each AI Coach request (`X-TE-AI-Key`) and the Worker
 * neither stores nor logs it.
 *
 * - **Excluded from backup and device transfer** in both `backup_rules.xml` and
 *   `data_extraction_rules.xml`: a key the driver pays for must not follow a
 *   restore onto another device silently — and a restored file is ciphertext
 *   whose keystore key did not come with it anyway.
 * - **Undecryptable is empty**, as [app.trackevolution.auth.AuthStore] is
 *   ([EncryptedPrefs]): the file and *its own* master key are wiped and
 *   reopened, costing a re-entered key. Its own alias, so that wipe can never
 *   take the sign-in token's key with it.
 * - **Cleared on sign-out** (`MainActivity`), beside the clip queue.
 *
 * The rules — which provider is active, what a forget does — are this class's
 * and run over a [Backend], so they are tested on the JVM with an in-memory one
 * (Robolectric has no AndroidKeyStore). The state is one JSON value.
 */
class AICoachKeys(
    private val backend: Backend,
    /** `BuildConfig.DEBUG` in the app: whether [AICoachKeysState.fake] is honoured at all. */
    private val fakeAllowed: Boolean = false,
) {
    interface Backend {
        fun read(): String?
        fun write(value: String?)
    }

    /** Memory only — tests, and the composition default where no store was provided. */
    class InMemory : Backend {
        private var value: String? = null
        override fun read(): String? = value
        override fun write(value: String?) {
            this.value = value
        }
    }

    private val _state: MutableStateFlow<AICoachKeysState> by lazy {
        val loaded = runCatching { backend.read()?.let { json.decodeFromString(AICoachKeysState.serializer(), it) } }
            .getOrNull()
        MutableStateFlow(clean(loaded ?: AICoachKeysState()))
    }

    val state: StateFlow<AICoachKeysState> get() = _state.asStateFlow()

    /** The fake provider is on: debug builds only. */
    val usesFake: Boolean get() = fakeAllowed && state.value.fake

    /** What an AI Coach request is sent with, or null when nothing is set up. */
    fun credential(): AICoachCredential? {
        if (usesFake) return AICoachCredential("fake", null, null)
        val s = state.value
        val id = s.activeId ?: return null
        val entry = s.keys.getValue(id)
        return AICoachCredential(id, entry.key, entry.model)
    }

    /** A key the provider accepted (`verify`); it becomes active when nothing else is. */
    fun save(provider: String, key: String, models: List<AICoachModel>, defaultModel: String?) {
        if (AICoach.COACH_PROVIDERS.none { it.id == provider } || key.isBlank()) return
        update { s ->
            val keys = s.keys + (provider to AICoachKey(key.trim(), null, defaultModel, models))
            s.copy(keys = keys, active = if (s.active == null || s.active !in keys) provider else s.active)
        }
    }

    fun forget(provider: String) = update { s ->
        val keys = s.keys - provider
        val next = s.copy(keys = keys)
        if (s.active == provider) next.copy(active = next.activeId) else next
    }

    fun setActive(provider: String) = update { s -> if (provider in s.keys) s.copy(active = provider) else s }

    /** The model id to send, or null for the provider's default. */
    fun setModel(provider: String, model: String?) = update { s ->
        val entry = s.keys[provider] ?: return@update s
        s.copy(keys = s.keys + (provider to entry.copy(model = model?.trim()?.takeIf { it.isNotEmpty() })))
    }

    /**
     * A fresh models list for [provider], read with [key] — dropped when the
     * key was forgotten or replaced while the request was out.
     */
    fun setModels(provider: String, key: String, models: List<AICoachModel>, defaultModel: String?) = update { s ->
        val entry = s.keys[provider]?.takeIf { it.key == key } ?: return@update s
        s.copy(keys = s.keys + (provider to entry.copy(models = models, defaultModel = defaultModel ?: entry.defaultModel)))
    }

    fun setFake(on: Boolean) = update { it.copy(fake = on) }

    /** Sign-out: nothing of the previous driver's stays on the phone. */
    fun clear() {
        _state.value = AICoachKeysState()
        runCatching { backend.write(null) }
    }

    private fun update(change: (AICoachKeysState) -> AICoachKeysState) {
        val next = clean(change(_state.value))
        _state.value = next
        runCatching {
            backend.write(if (next.keys.isEmpty() && !next.fake) null else json.encodeToString(AICoachKeysState.serializer(), next))
        }
    }

    /** Only the providers the AI Coach knows, and only keys that are there. */
    private fun clean(s: AICoachKeysState): AICoachKeysState {
        val ids = AICoach.COACH_PROVIDERS.map { it.id }
        val keys = s.keys.filter { (id, e) -> id in ids && e.key.isNotBlank() }
        return s.copy(keys = keys, active = s.active?.takeIf { it in keys })
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** "sk-ant-…x9Qf": enough to recognise a key by, never the key — `maskKey` in `js/ai-keys.js`. */
        fun maskKey(key: String): String = if (key.length > 14) "${key.take(7)}…${key.takeLast(4)}" else "…"

        const val FILE_NAME: String = "ai_coach"
        private const val MASTER_KEY_ALIAS = "ai_coach_master_key"
        private const val STATE_KEY = "state"

        /** The Keystore-backed store the app uses. */
        fun encrypted(context: Context, fakeAllowed: Boolean): AICoachKeys {
            val app = context.applicationContext
            return AICoachKeys(EncryptedBackend(app), fakeAllowed)
        }
    }

    private class EncryptedBackend(private val app: Context) : Backend {
        private val prefs: SharedPreferences by lazy {
            EncryptedPrefs.openOrReset(
                open = {
                    val masterKey = MasterKey.Builder(app, MASTER_KEY_ALIAS)
                        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                        .build()
                    EncryptedSharedPreferences.create(
                        app,
                        FILE_NAME,
                        masterKey,
                        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                    )
                },
                reset = { EncryptedPrefs.reset(app, FILE_NAME, MASTER_KEY_ALIAS) },
            )
        }

        override fun read(): String? = prefs.getString(STATE_KEY, null)

        override fun write(value: String?) {
            prefs.edit().run {
                if (value == null) remove(STATE_KEY) else putString(STATE_KEY, value)
                apply()
            }
        }
    }
}

/**
 * The AI Coach's keys for the screens below. Inert by default — an empty
 * in-memory store — like `LocalClipStatus`, so a Robolectric screen sees no key
 * unless a test provides one; `MainActivity` provides the encrypted store.
 */
val LocalAICoachKeys = staticCompositionLocalOf { AICoachKeys(AICoachKeys.InMemory()) }

/**
 * A server whose host the Worker treats as a dev host (`isDevHost` in
 * `src/lib/dev.ts`): the only place its fake AI provider answers. Decides
 * only whether a debug build *offers* the switch — the server is the gate.
 */
fun isDevServer(url: String): Boolean {
    val host = runCatching { java.net.URI(url).host }.getOrNull()?.lowercase() ?: return false
    return host in setOf("localhost", "127.0.0.1", "[::1]", "::1", "10.0.2.2")
}
