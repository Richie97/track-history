import Foundation
import TrackEvolutionKit

/// Everything the event form holds that the driver typed, as a value (epic #277,
/// ticket 1).
///
/// It exists because `RootView.navigationShell` swaps the stack shell for the
/// split shell across 840pt, and every screen's `@State` model goes with the old
/// container. On an iPad mini that is a rotation (744pt → 1133pt); on the iPhone
/// Duo it is rotating the open phone, or unfolding it while held landscape — so a
/// half-typed event died on the most ordinary gesture a phone has. Everything else
/// the swap resets re-fetches; this is the one screen whose state cannot.
///
/// The draft lives on ``AppRouter/eventFormDraft``, which is `@State` on
/// `RootView` itself and so outlives both shells — the same place, and the same
/// reason, as ``AppRouter/stagedSessions``. It is Android's `SavedStateHandle`
/// draft (`EventFormModel`'s `SavedState` plus its `hydrated` flag) at the level
/// iOS has one.
struct EventFormDraft: Equatable {
    /// Which form this is the draft of. A draft only ever restores into the form
    /// it came from — see ``restorable(_:for:)``.
    var target: EventFormTarget

    var trackName = ""
    var startDate = Date()
    var days: Double = 2
    var trackHours = ""
    var club = ""
    var runGroup = ""
    var car = ""
    var conditions: Conditions?
    var temp = ""
    var bestTime = ""
    var notes = ""

    var sessionLabel = ""
    var sessionLaps = ""
    var sessionNotes = ""
    /// The import review's hand-off, already taken by the form.
    var stagedSessions: [SessionDraft] = []
    /// The event a save already created when a session after it failed — kept so
    /// the retry never creates the event twice (`EventFormSessions`' rule).
    var createdId: Int?
    /// The edited event's track, so an unedited name doesn't re-resolve. Carried
    /// because a restored edit form skips the detail fetch that set it.
    var existingTrackId: Int?

    /// The draft for `target`, or nil when the held one belongs to another form —
    /// a different event's edit, or a new event while an edit was held. Opening a
    /// second form never inherits the first one's typing.
    static func restorable(_ held: EventFormDraft?, for target: EventFormTarget) -> EventFormDraft? {
        guard let held, held.target == target else { return nil }
        return held
    }

    /// Whether a held draft should be dropped, given every route still on a
    /// stack. A draft outlives its *screen* — that is the point — but not its
    /// *route*: once the form is popped, saved over or replaced, the typing is
    /// discarded with it. The shell swap leaves the path alone (it lives on the
    /// router), which is exactly what tells the two apart.
    static func isOrphaned(_ held: EventFormDraft, routes: [Route]) -> Bool {
        !routes.contains(.eventForm(held.target))
    }

    /// The draft with a temp event id followed to its real one, when the offline
    /// create behind an edit form flushes — the path's own route is rewritten by
    /// `AppRouter.remapTempIds`, and the draft has to stay attached to it.
    func remapped(_ resolve: (Int) -> Int?) -> EventFormDraft {
        var copy = self
        if case .edit(let id) = target, OfflineStore.isTemp(id), let real = resolve(id) {
            copy.target = .edit(real)
        }
        if let id = createdId, OfflineStore.isTemp(id), let real = resolve(id) {
            copy.createdId = real
        }
        return copy
    }
}
