package app.trackevolution.auth

import android.content.Context
import java.security.KeyStore

/**
 * Opening an [androidx.security.crypto.EncryptedSharedPreferences] file that
 * cannot be decrypted, without taking the app down with it.
 *
 * **The failure this exists for.** The prefs file is ciphertext; the key that
 * unwraps it lives in the AndroidKeyStore. Those two can come apart — an Auto
 * Backup restore carries the file and not the key (which is why the manifest now
 * excludes it: see `res/xml/backup_rules.xml`), a keystore entry can be
 * invalidated by a device-security change, and some OEM keystores simply corrupt
 * entries. When they do, Tink's unwrap throws `AEADBadTagException` out of
 * `EncryptedSharedPreferences.create`, and because the token store is read on
 * the first cold-start billing sync, the app crashed at launch every time. There
 * is no recovery a user can reach from that state short of clearing app data.
 *
 * **So undecryptable is treated as empty.** The file and its master key are
 * deleted and the store is opened fresh. The cost is one sign-in — which is the
 * honest outcome, since a token that cannot be decrypted is not a session — and
 * nothing else is touched: the offline queue holds recorded laps that exist
 * nowhere else, and it is a different database.
 */
internal object EncryptedPrefs {

    /**
     * Open with [open]; if that fails, [reset] and try exactly once more.
     *
     * Deliberately catching [Exception] rather than the declared
     * `GeneralSecurityException`/`IOException`: Tink reaches this state through
     * several exception types depending on which half came apart, and a launch
     * crash loop is a worse outcome than a wipe for any of them. The retry is
     * not itself retried — a second failure is a real fault and is thrown,
     * carrying the first as a suppressed exception so the crash report names the
     * original cause rather than a mystery about an empty directory.
     */
    fun <T> openOrReset(open: () -> T, reset: () -> Unit): T =
        try {
            open()
        } catch (corrupt: Exception) {
            try {
                reset()
            } catch (resetFailed: Exception) {
                corrupt.addSuppressed(resetFailed)
            }
            try {
                open()
            } catch (again: Exception) {
                again.addSuppressed(corrupt)
                throw again
            }
        }

    /**
     * Delete an encrypted prefs file and the keystore entry that wraps it.
     *
     * Both halves are required. The two Tink keysets live *inside* [fileName]'s
     * own prefs file, so deleting it drops them with the data — but leaving the
     * master key in place would hand the fresh keyset the same unusable entry
     * when the key is what came apart, and the next open would fail identically.
     */
    fun reset(context: Context, fileName: String, masterKeyAlias: String) {
        context.deleteSharedPreferences(fileName)
        runCatching {
            KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }.deleteEntry(masterKeyAlias)
        }
    }

    private const val ANDROID_KEY_STORE = "AndroidKeyStore"
}
