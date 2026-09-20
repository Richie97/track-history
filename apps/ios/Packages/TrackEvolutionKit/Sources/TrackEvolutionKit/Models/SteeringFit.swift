import Foundation

/// `GET /api/vehicles/:id/steering-fit` (#223): the per-session steering fits
/// behind the vehicle form's "Measured from 6 sessions: 15.8:1" line —
/// `steeringFit` run server-side over the car's most recent channel-carrying
/// sessions, newest first, only the ones that fit. The client pools them with
/// `Balance.estimateSteeringRatio` against the wheelbase *in the form*, which
/// may not be the stored one yet, so the ratio itself is not in the response.
/// Pro, like the rest of the garage; a read, so it caches like any other.
public struct SteeringFits: Codable, Hashable, Sendable {
    public var fits: [SteeringFit]

    public init(fits: [SteeringFit]) {
        self.fits = fits
    }
}

/// One session's fit with where it came from. The four numbers are
/// `Balance.Fit`'s, spelled the same.
public struct SteeringFit: Codable, Hashable, Sendable, Identifiable {
    public var sessionId: Int
    public var eventId: Int
    /// The event's start date, ISO `YYYY-MM-DD`.
    public var startDate: String
    public var gain0: Double
    public var K: Double
    public var samples: Int
    public var r2: Double

    public enum CodingKeys: String, CodingKey {
        case gain0, K, samples, r2
        case sessionId = "session_id"
        case eventId = "event_id"
        case startDate = "start_date"
    }

    public var id: Int { sessionId }

    /// The fit as the pooling reads it.
    public var fit: Balance.Fit { Balance.Fit(gain0: gain0, K: K, samples: samples, r2: r2) }

    public init(sessionId: Int, eventId: Int, startDate: String, gain0: Double, K: Double, samples: Int, r2: Double) {
        self.sessionId = sessionId
        self.eventId = eventId
        self.startDate = startDate
        self.gain0 = gain0
        self.K = K
        self.samples = samples
        self.r2 = r2
    }
}
