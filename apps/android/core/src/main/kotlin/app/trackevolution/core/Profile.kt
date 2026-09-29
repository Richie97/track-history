package app.trackevolution.core

import app.trackevolution.core.model.DriverProfile

/**
 * The driver profile (NS-38): the field spec the profile form renders, and the
 * grouped lines a coach reads — the port of `public/js/profile.js`, under the
 * same names, pinned by `contracts/logic/coaching.json`.
 *
 * Mirrors `sanitizeProfile` in `src/lib/profile.ts` the way the web module
 * does: the server is the one that validates, so a field added here without it
 * is dropped on save. Deliberately no birth date and no emergency contact.
 */
public object Profile {

    /** `kind` in the JS spec. */
    public enum class Kind(public val wire: String) {
        /** One line, 200 characters. */
        TEXT("text"),

        /** A box, 1,000 characters. */
        LONG("long"),
        YEAR("year"),
        SELECT("select"),

        /** Asked as a three-way choice — unanswered, yes, no — never a checkbox. */
        BOOL("bool"),
    }

    /**
     * One form field. [max] is the server's cap, so the form can stop a save
     * before it is refused; [options] is `[value, label]` pairs for a select.
     */
    public data class Field(
        val key: String,
        val label: String,
        val kind: Kind,
        val max: Int? = null,
        val placeholder: String? = null,
        val options: List<Pair<String, String>>? = null,
    )

    public data class Group(val title: String, val fields: List<Field>)

    /** One line a coach reads. */
    public data class Row(val key: String, val label: String, val value: String)

    public data class Section(val title: String, val rows: List<Row>)

    public val HELMET_RATINGS: List<Pair<String, String>> = listOf(
        "SA2020" to "Snell SA2020",
        "SA2025" to "Snell SA2025",
        "SAH2020" to "Snell SAH2020",
        "FIA8859" to "FIA 8859",
        "M" to "Snell M (motorcycle)",
        "other" to "Other",
    )

    public val HEAD_NECK: List<Pair<String, String>> = listOf(
        "none" to "None",
        "hans" to "HANS",
        "hybrid" to "Hybrid-style",
        "other" to "Other",
    )

    public val PROFILE_GROUPS: List<Group> = listOf(
        Group(
            "About you",
            listOf(Field("occupation", "Occupation", Kind.TEXT, 200, "Engineer, nurse, pilot…")),
        ),
        Group(
            "Experience",
            listOf(
                Field("first_track_year", "First track day (year)", Kind.YEAR, placeholder = "2019"),
                Field("experience", "Other driving", Kind.LONG, 1000, "Karting since 2012, autocross, sim racing…"),
                Field("license", "Competition licence", Kind.TEXT, 200, "NASA HPDE4, SCCA novice…"),
                Field("instruction", "Instruction so far", Kind.LONG, 1000, "Two schools, signed off to solo in 2024…"),
            ),
        ),
        Group(
            "Safety gear",
            listOf(
                Field("helmet", "Helmet", Kind.TEXT, 200, "Make and model"),
                Field("helmet_rating", "Helmet rating", Kind.SELECT, options = HELMET_RATINGS),
                Field("head_neck", "Head & neck restraint", Kind.SELECT, options = HEAD_NECK),
                Field("suit", "Suit", Kind.TEXT, 200, "Single-layer SFI 3.2A/1…"),
                Field("gloves", "Driving gloves", Kind.BOOL),
                Field("shoes", "Driving shoes", Kind.BOOL),
                Field("gear_notes", "Anything else about your gear", Kind.LONG, 1000, "Wears glasses, arm restraints…"),
            ),
        ),
        Group(
            "Coaching",
            listOf(
                Field(
                    "goals", "What I want to work on", Kind.LONG, 1000,
                    "Trail braking into T1, carrying speed through the esses…",
                ),
                Field(
                    "for_instructor", "Anything your instructor should know", Kind.LONG, 1000,
                    "An old injury, nerves in traffic, first time in this car…",
                ),
            ),
        ),
    )

    public val PROFILE_FIELDS: List<Field> = PROFILE_GROUPS.flatMap { it.fields }

    /**
     * A profile's value by its wire key — the JS module indexes the object by
     * `f.key`, which a data class cannot, so this is that lookup spelled out.
     */
    public fun valueOf(profile: DriverProfile, key: String): Any? = when (key) {
        "occupation" -> profile.occupation
        "first_track_year" -> profile.firstTrackYear
        "experience" -> profile.experience
        "license" -> profile.license
        "instruction" -> profile.instruction
        "helmet" -> profile.helmet
        "helmet_rating" -> profile.helmetRating
        "head_neck" -> profile.headNeck
        "suit" -> profile.suit
        "gloves" -> profile.gloves
        "shoes" -> profile.shoes
        "gear_notes" -> profile.gearNotes
        "goals" -> profile.goals
        "for_instructor" -> profile.forInstructor
        else -> null
    }

    /**
     * One field's value as a coach reads it, or null when there is nothing to
     * say. A boolean is said either way — "No" driving gloves is something an
     * instructor wants to know before the first session.
     */
    public fun profileValueText(field: Field, value: Any?): String? {
        if (value == null || value == "") return null
        return when (field.kind) {
            Kind.BOOL -> if (value == true) "Yes" else "No"
            Kind.SELECT -> field.options?.firstOrNull { it.first == value }?.second ?: value.toString()
            Kind.YEAR -> value.toString()
            else -> value.toString().trim().ifEmpty { null }
        }
    }

    /**
     * The profile as grouped lines, with empty fields and then empty groups
     * left out, so a half-filled profile reads as what it says rather than as a
     * form full of blanks.
     */
    public fun profileSections(profile: DriverProfile?): List<Section> {
        if (profile == null) return emptyList()
        return PROFILE_GROUPS.map { group ->
            Section(
                group.title,
                group.fields.mapNotNull { f ->
                    profileValueText(f, valueOf(profile, f.key))?.let { Row(f.key, f.label, it) }
                },
            )
        }.filter { it.rows.isNotEmpty() }
    }

    /**
     * The request body from a form's raw values — strings from fields, `"yes"` /
     * `"no"` / `""` (or a Boolean) from the three-way choices. Blanks become null,
     * which the server reads as "not set", and the year becomes a number.
     * Validation stays the server's; a year that is not a whole number is sent
     * as null rather than guessed at (the form's number keyboard makes that the
     * rare case).
     */
    public fun profileBody(values: Map<String, Any?>): DriverProfile {
        fun text(key: String): String? = values[key]?.toString()?.trim()?.ifEmpty { null }
        fun bool(key: String): Boolean? = when (values[key]) {
            true, "yes" -> true
            false, "no" -> false
            else -> null
        }
        return DriverProfile(
            occupation = text("occupation"),
            firstTrackYear = text("first_track_year")?.toIntOrNull(),
            experience = text("experience"),
            license = text("license"),
            instruction = text("instruction"),
            helmet = text("helmet"),
            helmetRating = text("helmet_rating"),
            headNeck = text("head_neck"),
            suit = text("suit"),
            gloves = bool("gloves"),
            shoes = bool("shoes"),
            gearNotes = text("gear_notes"),
            goals = text("goals"),
            forInstructor = text("for_instructor"),
        )
    }

    /**
     * The reverse of [profileBody]: a stored profile as the form's raw values,
     * so an edit starts from what is saved.
     */
    public fun formValues(profile: DriverProfile?): Map<String, String> = PROFILE_FIELDS.associate { f ->
        val v = profile?.let { valueOf(it, f.key) }
        f.key to when (v) {
            null -> ""
            true -> "yes"
            false -> "no"
            else -> v.toString()
        }
    }
}
