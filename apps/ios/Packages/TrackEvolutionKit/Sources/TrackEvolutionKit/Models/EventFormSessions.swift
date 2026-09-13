import Foundation

/// The New Event form's "Add laps" section — the pure half, ported from
/// `public/js/event-form.js` under the same names and pinned to it by
/// `contracts/logic/event-form.json`.
///
/// The form stages sessions until "Create event": clips the import review
/// handed back and, optionally, one session typed by hand. Nothing is posted
/// before the event exists — the event is created first, then each session is
/// `POST /events/:id/sessions` in the order ``sessionsToCreate`` returns, so
/// the logbook reads the way the form did. A hand entry with no parseable laps
/// is dropped rather than posted as an empty session.
public enum EventFormSessions {
    /// Every session to create for a new event, in posting order: the staged
    /// imports first, in the order they were staged, then the hand-typed one
    /// when it holds at least one lap. The typed fields are passed as typed;
    /// blank label and notes go out as nil, as the event page's form sends them.
    public static func sessionsToCreate(
        staged: [SessionDraft],
        label: String?,
        laps: String?,
        notes: String?
    ) -> [SessionDraft] {
        let parsed = LapTime.parseLapList(laps)
        guard !parsed.isEmpty else { return staged }
        return staged + [
            SessionDraft(
                label: trimmedOrNil(label),
                notes: trimmedOrNil(notes),
                laps: parsed
            ),
        ]
    }

    /// "9 laps · best 2:01.24" — one staged session's line on the form.
    public static func stagedSummary(laps: [Int]) -> String {
        let n = laps.count
        let count = "\(n) lap\(n == 1 ? "" : "s")"
        guard let best = laps.min() else { return count }
        return "\(count) · best \(LapTime.fmtMs(best))"
    }

    private static func trimmedOrNil(_ text: String?) -> String? {
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
