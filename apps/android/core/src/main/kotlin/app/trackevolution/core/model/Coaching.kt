package app.trackevolution.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Share with a coach (NS-38, docs/specs/native/NS-38-coach-sharing.md).
//
// Decoded here ahead of the Android screens (ticket 4) so the golden contract
// pins them from the server PR on; nothing reads them yet. A coach's view of a
// student's logbook — `GET /api/students/:id/events`, `/events/:id`, `/tracks`,
// `/vehicles` — decodes into the ordinary [Event], [EventDetail], [Track] and
// [Vehicle]: the server sends the fields a coach may not see as null (or an
// empty list), never as a different shape.

/**
 * The driver profile: what a driver tells their instructor about themselves.
 * Every field optional; validated by `sanitizeProfile` in `src/lib/profile.ts`.
 * The birth date is ISO `YYYY-MM-DD`; age is derived, never stored.
 */
@Serializable
public data class DriverProfile(
    @SerialName("date_of_birth") val dateOfBirth: String? = null,
    @SerialName("occupation") val occupation: String? = null,
    @SerialName("emergency_name") val emergencyName: String? = null,
    @SerialName("emergency_phone") val emergencyPhone: String? = null,
    @SerialName("first_track_year") val firstTrackYear: Int? = null,
    @SerialName("experience") val experience: String? = null,
    @SerialName("license") val license: String? = null,
    @SerialName("instruction") val instruction: String? = null,
    @SerialName("helmet") val helmet: String? = null,
    /** `SA2020`, `SA2025`, `SAH2020`, `FIA8859`, `M` or `other`. */
    @SerialName("helmet_rating") val helmetRating: String? = null,
    /** `none`, `hans`, `hybrid` or `other`. */
    @SerialName("head_neck") val headNeck: String? = null,
    @SerialName("suit") val suit: String? = null,
    @SerialName("gloves") val gloves: Boolean? = null,
    @SerialName("shoes") val shoes: Boolean? = null,
    @SerialName("gear_notes") val gearNotes: String? = null,
    @SerialName("goals") val goals: String? = null,
    @SerialName("for_instructor") val forInstructor: String? = null,
)

/**
 * `GET /api/me/profile` — and, under `/api/students/:id`, the student's. [pro]
 * is the profile owner's tier: in a student's logbook it, not the viewer's
 * own entitlement, decides whether the channel panel opens.
 */
@Serializable
public data class ProfileResponse(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
    @SerialName("pro") val pro: Boolean,
    @SerialName("profile") val profile: DriverProfile? = null,
)

/** `PUT /api/me/profile`: the profile as stored, trimmed; null when cleared. */
@Serializable
public data class ProfileSaved(
    @SerialName("ok") val ok: Boolean,
    @SerialName("profile") val profile: DriverProfile? = null,
)

/** `GET /api/coaching`: both directions of the grant, and the open invites. */
@Serializable
public data class Coaching(
    @SerialName("coaches") val coaches: List<Coach>,
    @SerialName("students") val students: List<Student>,
    @SerialName("invites") val invites: List<OpenInvite>,
)

@Serializable
public data class Coach(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
    @SerialName("since") val since: Long,
    @SerialName("last_viewed_at") val lastViewedAt: Long? = null,
)

@Serializable
public data class Student(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
    @SerialName("since") val since: Long,
    /** Past events only, on the totals' rule. */
    @SerialName("event_count") val eventCount: Int,
    @SerialName("last_event_date") val lastEventDate: String? = null,
)

/** An unused invite. Its link was shown once, at creation, and can't be again. */
@Serializable
public data class OpenInvite(
    @SerialName("id") val id: Int,
    @SerialName("created_at") val createdAt: Long,
    @SerialName("expires_at") val expiresAt: Long,
)

/** `POST /api/coaching/invites` (Pro): the one time the link is shown. */
@Serializable
public data class CoachInvite(
    @SerialName("id") val id: Int,
    @SerialName("url") val url: String,
    @SerialName("expires_at") val expiresAt: Long,
)

/** The student an invite shares, as its preview and its acceptance name them. */
@Serializable
public data class InviteStudent(
    @SerialName("id") val id: Int,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
)

/** `GET /api/coaching/invites/:token`. */
@Serializable
public data class InvitePreview(
    @SerialName("student") val student: InviteStudent,
    @SerialName("expires_at") val expiresAt: Long,
    /** The caller's own invite: accepting is refused. */
    @SerialName("own") val own: Boolean,
    @SerialName("already_coach") val alreadyCoach: Boolean,
)

/** `POST /api/coaching/invites/:token/accept`. */
@Serializable
public data class InviteAccepted(
    @SerialName("student") val student: InviteStudent,
)
