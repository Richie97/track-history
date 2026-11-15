package app.trackevolution.push

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import app.trackevolution.MainActivity
import app.trackevolution.R
import app.trackevolution.core.DeepLink
import app.trackevolution.navigation.Route
import app.trackevolution.navigation.routeFor
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The in-context ask (NS-54), as a pure decision. */
class CommentPushAskTest {

    @Test
    fun `a student is asked once a coach has spoken, a coach once they have`() {
        assertTrue(CommentPushAsk.shouldOffer(isOwner = true, hasTheirs = true, hasMine = false, enabled = false, asked = false))
        assertTrue(CommentPushAsk.shouldOffer(isOwner = false, hasTheirs = false, hasMine = true, enabled = false, asked = false))
    }

    @Test
    fun `never before it means something, never twice, never when already on`() {
        assertFalse(CommentPushAsk.shouldOffer(isOwner = true, hasTheirs = false, hasMine = true, enabled = false, asked = false))
        assertFalse(CommentPushAsk.shouldOffer(isOwner = false, hasTheirs = true, hasMine = false, enabled = false, asked = false))
        assertFalse(CommentPushAsk.shouldOffer(isOwner = true, hasTheirs = true, hasMine = false, enabled = false, asked = true))
        assertFalse(CommentPushAsk.shouldOffer(isOwner = true, hasTheirs = true, hasMine = false, enabled = true, asked = false))
    }

    @Test
    fun `only Android 13 and later have a permission to ask for`() {
        assertTrue(CommentPushAsk.needsPermission(33, granted = false))
        assertFalse(CommentPushAsk.needsPermission(33, granted = true))
        assertFalse(CommentPushAsk.needsPermission(32, granted = false))
    }

    @Test
    fun `a tapped notification lands on the lap or the event, in the right logbook`() {
        assertEquals(Route.Lap(30, 40, 50), routeFor(DeepLink.CommentPush(30, 40, 50, null)))
        assertEquals(Route.Lap(30, 40, 50, student = 9), routeFor(DeepLink.CommentPush(30, 40, 50, 9)))
        assertEquals(Route.Event(30), routeFor(DeepLink.CommentPush(30, 40, null, null)))
        assertEquals(Route.Event(30, student = 9), routeFor(DeepLink.CommentPush(30, 40, null, 9)))
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushRegistrarTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val calls = mutableListOf<String>()
    private var signedIn = true
    private var allowed = true
    private var token = "tok-1"
    private var failing = false

    private fun registrar(scope: TestScope, prefs: PushPrefs = PushPrefs(context)) = PushRegistrar(
        scope = scope,
        register = { if (failing) error("offline"); calls += "register $it" },
        unregister = { if (failing) error("offline"); calls += "unregister" },
        tokens = { token },
        isSignedIn = { signedIn },
        notificationsAllowed = { allowed },
        prefs = prefs,
    )

    @Before
    fun clear() {
        context.getSharedPreferences(PushPrefs.FILE, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun `nothing registers until the driver turns it on`() = runTest(StandardTestDispatcher()) {
        val r = registrar(this)
        r.onSignedIn()
        r.onNewToken("tok-2")
        advanceUntilIdle()
        assertEquals(emptyList<String>(), calls)
    }

    @Test
    fun `turning it on registers, and every sign-in registers again`() = runTest(StandardTestDispatcher()) {
        val r = registrar(this)
        r.setEnabled(true)
        advanceUntilIdle()
        assertEquals(listOf("register tok-1"), calls)
        assertTrue(r.enabled.value)
        assertTrue("turning it on answers the ask", r.asked.value)

        // A new session (a sign-out and back in) is a new device row server-side.
        r.onSignedIn()
        advanceUntilIdle()
        assertEquals(listOf("register tok-1", "register tok-1"), calls)
    }

    @Test
    fun `a rotated token is registered only while it is wanted`() = runTest(StandardTestDispatcher()) {
        val r = registrar(this)
        r.setEnabled(true)
        r.onNewToken("tok-2")
        advanceUntilIdle()
        assertEquals(listOf("register tok-1", "register tok-2"), calls)

        signedIn = false
        r.onNewToken("tok-3")
        advanceUntilIdle()
        assertEquals(2, calls.size)
    }

    @Test
    fun `turning it off unregisters this phone`() = runTest(StandardTestDispatcher()) {
        val r = registrar(this)
        r.setEnabled(true)
        advanceUntilIdle()
        r.setEnabled(false)
        advanceUntilIdle()
        assertEquals(listOf("register tok-1", "unregister"), calls)
        assertFalse(r.enabled.value)
    }

    @Test
    fun `a quick flip ends where the driver left it`() = runTest(StandardTestDispatcher()) {
        val r = registrar(this)
        r.setEnabled(true)
        r.setEnabled(false)
        advanceUntilIdle()
        assertEquals(listOf("unregister"), calls)
        calls.clear()
        r.setEnabled(false)
        r.setEnabled(true)
        advanceUntilIdle()
        assertEquals("register tok-1", calls.last())
    }

    @Test
    fun `no permission, no registration`() = runTest(StandardTestDispatcher()) {
        allowed = false
        val r = registrar(this)
        r.setEnabled(true)
        advanceUntilIdle()
        assertEquals(emptyList<String>(), calls)
    }

    @Test
    fun `a failure is swallowed and the next sign-in tries again`() = runTest(StandardTestDispatcher()) {
        failing = true
        val r = registrar(this)
        r.setEnabled(true)
        advanceUntilIdle()
        assertEquals(emptyList<String>(), calls)
        failing = false
        r.onSignedIn()
        advanceUntilIdle()
        assertEquals(listOf("register tok-1"), calls)
    }

    @Test
    fun `the choice survives a restart, and Not now is remembered`() = runTest(StandardTestDispatcher()) {
        registrar(this).markAsked()
        registrar(this).setEnabled(true)
        advanceUntilIdle()
        val fresh = PushPrefs(context)
        assertTrue(fresh.enabled.value)
        assertTrue(fresh.asked.value)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CommentNotificationsTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val payload = mapOf(
        "kind" to "comment", "comment_id" to "7", "event_id" to "30",
        "session_id" to "40", "lap_id" to "50", "student_id" to "9",
    )

    @Test
    fun `the channel is the one the server names`() {
        CommentNotifications.ensureChannel(context)
        val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel("coach_comments")
        assertNotNull(channel)
        assertEquals("Coach comments", channel.name)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, channel.importance)
    }

    @Test
    fun `a foreground message is posted on the channel, grouped by event, opening the comment`() {
        shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
        CommentNotifications.show(context, "Sam Lee commented on Lap 6 · VIR", "Brake later.", payload)
        val manager = shadowOf(context.getSystemService(NotificationManager::class.java))
        val posted = manager.getNotification("event-30", 7)
        assertNotNull(posted)
        assertEquals("coach_comments", posted.channelId)
        assertEquals(R.drawable.ic_stat_comment, posted.smallIcon.resId)

        val tapped = shadowOf(posted.contentIntent).savedIntent
        assertEquals(MainActivity::class.java.name, tapped.component?.className)
        assertEquals("comment", tapped.getStringExtra("kind"))
        assertEquals("50", tapped.getStringExtra("lap_id"))
        assertEquals(DeepLink.CommentPush(30, 40, 50, 9), CommentNotifications.fromIntent(tapped))
    }

    @Test
    fun `FCM's own tap reads the same, and any other launch reads nothing`() {
        val fcm = Intent(Intent.ACTION_MAIN).apply { for ((k, v) in payload) putExtra(k, v) }
        assertEquals(DeepLink.CommentPush(30, 40, 50, 9), CommentNotifications.fromIntent(fcm))
        assertNull(CommentNotifications.fromIntent(Intent(Intent.ACTION_MAIN)))
        assertNull(CommentNotifications.fromIntent(null))
        assertNull(CommentNotifications.fromIntent(Intent().putExtra("kind", "other").putExtra("event_id", "1")))
    }

    @Test
    fun `nothing is posted when Android is blocking the app`() {
        val shadow = shadowOf(context.getSystemService(NotificationManager::class.java))
        shadow.setNotificationsEnabled(false)
        CommentNotifications.show(context, "t", "b", payload)
        assertNull(shadow.getNotification("event-30", 7))
    }
}
