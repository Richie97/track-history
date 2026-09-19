package app.trackevolution.core.model

import app.trackevolution.core.Garage
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One generation of the seeded car catalog (`GET /api/car-catalog`, #221): the
 * make / model / generation a driver picks a car by, the two spec-sheet numbers
 * a pick pre-fills on the vehicle ([Vehicle.wheelbaseMm], [Vehicle.steeringRatio]),
 * and where both came from.
 *
 * [steeringRatio] is null where no single reliable figure exists — a
 * variable-ratio rack the maker only quotes as a range, or a generation nobody
 * has curated yet — and never a guess; [source] says which. The whole catalog is
 * small enough to ship in one response, which is what lets the picker (#222)
 * work offline from the response cache.
 */
@Serializable
public data class CatalogCar(
    val id: Int,
    val make: String,
    val model: String,
    /** The user-facing disambiguator ("C7", "ND", "981"); null when a model has only ever had one. */
    val generation: String? = null,
    @SerialName("year_from") val yearFrom: Int,
    /** null while still in production. */
    @SerialName("year_to") val yearTo: Int? = null,
    @SerialName("wheelbase_mm") val wheelbaseMm: Int,
    @SerialName("steering_ratio") val steeringRatio: Double? = null,
    val source: String,
) {
    /**
     * "Chevrolet Corvette C7" — the name a pick gives an unnamed car
     * ([Garage.catalogCarName]; the picker row itself reads [Garage.catalogCarLabel]).
     */
    val displayName: String
        get() = Garage.catalogCarName(this)

    /** "2014–2019" or "2020–" — the years beside a row ([Garage.catalogCarYears]). */
    val yearRange: String
        get() = Garage.catalogCarYears(this)
}
