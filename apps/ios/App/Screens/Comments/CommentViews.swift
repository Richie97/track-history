import SwiftUI
import TrackEvolutionKit

// Coach comments on sessions and laps (NS-52,
// docs/specs/native/NS-52-coach-comments.md): the model one event's comments
// are read and written through, a comment's card, and the composer. The
// pages that show them are the lap page (`LapCommentsCard`), the event page
// (`SessionCommentsRows`) and the pushed session form (`SessionCommentScreen`).
//
// **The read-only seam's one exception.** A student's logbook is read-only for
// a coach — the scoped client throws `APIError.readOnly` on every write — except
// for this. Comments go through the **unscoped** `auth.api`, whose comment
// routes pick the coach's own `/coaching/students/<id>/…` from the owner, and
// every other control on the page still hides on `owner.isReadOnly`.

/// One event's comments: what a coach said about its sessions, its laps and
/// places on them, and the driver's replies. Read from their own route, never
/// part of the event detail, so a page never waits on them and a failure
/// (offline with nothing cached) only leaves them out.
@MainActor
@Observable
final class CommentsModel {
    /// The unscoped client — see the note at the top of this file.
    let api: APIClient
    let owner: LogbookOwner
    let eventId: Int
    /// The signed-in account: on a student's logbook, the coach whose thread
    /// this page shows.
    let viewerId: Int?

    private(set) var comments: [CoachComment] = []
    private(set) var coaches: [EventComments.Coach] = []
    private(set) var loaded = false

    init(api: APIClient, owner: LogbookOwner, eventId: Int, viewerId: Int?) {
        self.api = api
        self.owner = owner
        self.eventId = eventId
        self.viewerId = viewerId
    }

    /// Whether the viewer owns the logbook: a reply into a coach's thread, and
    /// a delete on any comment in it.
    var isOwner: Bool { !owner.isReadOnly }

    var counts: Comments.Counts { Comments.commentCounts(comments) }

    var hasUnread: Bool { comments.contains { !$0.mine && !$0.seen } }

    /// Read them. An event created offline has no server id to ask about yet.
    func load() async {
        guard !OfflineStore.isTemp(eventId) else { return }
        guard let read = try? await api.eventComments(eventId: eventId, owner: owner) else { return }
        comments = read.comments
        coaches = read.coaches ?? []
        loaded = true
    }

    /// Tell the server what is on screen has been read — only when something
    /// is unread, and never from a prefetch: seeing is something a person does.
    /// Answers how many it marked, for the badge.
    @discardableResult
    func markSeen() async -> Int {
        guard hasUnread, let seen = try? await api.markCommentsSeen(eventId: eventId, owner: owner) else { return 0 }
        for index in comments.indices where !comments[index].mine {
            comments[index].seen = true
        }
        return seen.seen
    }

    /// One session's threads: the owner's one per coach who has spoken on it;
    /// a coach's own, always — empty, it is where they start.
    func threads(sessionId: Int) -> [Comments.Thread] {
        let here = comments.filter { $0.sessionId == sessionId }
        if isOwner { return Comments.commentThreads(here) }
        return [Comments.Thread(coachId: viewerId ?? 0, comments: here)]
    }

    func coach(_ id: Int) -> EventComments.Coach? {
        coaches.first { $0.id == id }
    }

    /// Whether a thread takes a new comment from this viewer: a coach always
    /// (they reached the page through a live grant); the owner while that
    /// coach still has access.
    func isOpen(_ thread: Comments.Thread) -> Bool {
        isOwner ? Comments.canReply(coach(thread.coachId)) : true
    }

    /// A session's placed comments on its channel panel: each on its lap's
    /// own channel entry, as a fractional grid index — drawn by the panel's
    /// overlay as a ◆, never in a chart's data.
    func panelMarks(_ session: Session) -> [LapChannelPanel.CommentMark] {
        guard let channels = session.channels, channels.dStepM > 0, !channels.laps.isEmpty else { return [] }
        let matched = ChannelGraphs.matchLapsToChannels(session.laps, channels.laps).filter(\.hasChannels)
        return comments.compactMap { c in
            guard c.sessionId == session.id, let lapId = c.lapId, let distM = c.distM,
                  let chIdx = matched.first(where: { $0.lap.id == lapId })?.chIdx
            else { return nil }
            return LapChannelPanel.CommentMark(id: c.id, chIdx: chIdx, k: Double(distM) / channels.dStepM)
        }
    }

    /// …and on the session's map, every lap's, as fractions of that lap's own
    /// length (`Comments.commentMarkers`). The map is the best lap's line, so a
    /// mark is the place, whichever lap it was said about.
    func mapFractions(_ session: Session) -> [Double] {
        guard let channels = session.channels else { return [] }
        let matched = ChannelGraphs.matchLapsToChannels(session.laps, channels.laps).filter(\.hasChannels)
        return matched.flatMap { match -> [Double] in
            let length = LapAxis.lapAxisSeries(channels.laps[match.chIdx], channels.dStepM, .distance)?.last
            return Comments.commentMarkers(comments, match.lap.id, length).map(\.frac)
        }
    }

    /// Send; throws for the composer to word with `Comments.commentError`.
    func send(sessionId: Int, coachId: Int, body: String, lapId: Int?, distM: Int?) async throws {
        _ = try await api.postComment(
            sessionId: sessionId, owner: owner, coachId: coachId, body: body, lapId: lapId, distM: distM
        )
        await load()
    }

    func edit(_ id: Int, body: String) async throws {
        _ = try await api.updateComment(id: id, body: body)
        await load()
    }

    func delete(_ id: Int) async throws {
        try await api.deleteComment(id: id)
        comments.removeAll { $0.id == id }
        await load()
    }
}

// MARK: - A comment

/// One comment: who, when, where on the lap, what was said, and what can be
/// done with it. **One accessibility element** with named actions — *Reply*,
/// *Edit*, *Delete*, *Report*, *Show on lap*, and the block (*Remove coach* /
/// *Stop coaching*) — the chart-card rule: the buttons on it are small, and a
/// VoiceOver user reaches every one of them from the card itself.
struct CommentCard: View {
    let comment: CoachComment
    let model: CommentsModel
    /// "in T4 · 1.2 km", or nil for an unplaced comment.
    var place: String?
    /// Move the stage there — nil where there is nothing to move.
    var onShow: (() -> Void)?
    /// Answer it — nil where the thread is closed or the viewer wrote it.
    var onReply: (() -> Void)?

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL

    @State private var editing: String?
    @State private var error: String?
    @State private var busy = false
    /// The card's one confirmation — one presentation per view.
    @State private var confirming: Confirm?

    private enum Confirm: Hashable {
        case delete
        case block(CoachingModel.Confirmation)
    }

    private var who: String { comment.mine ? "You" : (comment.author.name ?? "Someone") }

    private var when: String {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        return (Comments.commentWhen(comment.createdAt, now) ?? CoachingScreen.dateOfMs(comment.createdAt))
            + (comment.editedAt != nil ? " · edited" : "")
    }

    private var canDelete: Bool { comment.mine || model.isOwner }

    /// The block the stores ask for beside another person's comment: the owner
    /// removes the coach (while they still have access), a coach stops
    /// coaching the student.
    private var block: CoachingModel.Confirmation? {
        guard !comment.mine else { return nil }
        if model.isOwner {
            guard Comments.canReply(model.coach(comment.coachId)) else { return nil }
            return .removeCoach(id: comment.coachId, name: comment.author.name ?? "this coach")
        }
        guard let id = model.owner.studentId else { return nil }
        return .leave(id: id, name: model.owner.displayName)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(who)
                    .teStyle(.sm)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color(.textStrong))
                Text(when)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                if comment.mine && comment.seen {
                    Text("· seen")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                }
                Spacer(minLength: 0)
                if !comment.mine && !comment.seen {
                    Circle().fill(Color(.accent)).frame(width: 7, height: 7)
                }
            }
            if let place {
                if let onShow {
                    Button("◆ \(place)", action: onShow)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.accentInk))
                        .buttonStyle(.plain)
                } else {
                    Text("◆ \(place)")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
            }
            if let draft = editing {
                editor(draft)
            } else {
                Text(comment.body)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textBody))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                actionRow
            }
            if let error {
                Text(error)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.dangerInk))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.bgSubtle), in: .rect(cornerRadius: TERadius.md))
        .accessibilityElement(children: editing == nil ? .ignore : .contain)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier("comment-\(comment.id)")
        .accessibilityActions {
            if let onReply { Button("Reply", action: onReply) }
            if comment.mine { Button("Edit") { editing = comment.body } }
            if canDelete { Button("Delete") { confirming = .delete } }
            if !comment.mine { Button(Comments.REPORT_LABEL) { report() } }
            if let onShow, place != nil { Button("Show on lap", action: onShow) }
            if let block { Button(block.action) { confirming = .block(block) } }
        }
        .confirmationDialog(
            question,
            isPresented: .init(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible,
            presenting: confirming
        ) { confirm in
            switch confirm {
            case .delete:
                Button("Delete comment", role: .destructive) { Task { await delete() } }
            case .block(let block):
                Button(block.action, role: .destructive) { Task { await perform(block) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var question: String {
        switch confirming {
        case .delete: "Delete this comment?"
        case .block(let block): block.question
        case nil: ""
        }
    }

    /// "Sam Lee, 2 hours ago, in T4 · 1.2 km. Brake later here. Unread."
    private var accessibilityText: String {
        var parts = ["\(who), \(when)"]
        if let place { parts.append(place) }
        parts.append(comment.body)
        if !comment.mine && !comment.seen { parts.append("Unread") }
        if comment.mine && comment.seen { parts.append("Seen") }
        return parts.joined(separator: ". ")
    }

    private var actionRow: some View {
        HStack(spacing: 14) {
            if let onReply {
                Button("Reply", action: onReply)
            }
            if comment.mine {
                Button("Edit") { editing = comment.body }
            }
            if canDelete {
                Button("Delete") { confirming = .delete }
            }
            if !comment.mine {
                Button(Comments.REPORT_LABEL) { report() }
                    .accessibilityIdentifier("reportComment-\(comment.id)")
            }
            if let block {
                Button(block.action) { confirming = .block(block) }
            }
        }
        .teStyle(.xs)
        .foregroundStyle(Color(.textMuted))
        .buttonStyle(.plain)
    }

    private func editor(_ draft: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                "Edit your comment",
                text: .init(get: { editing ?? "" }, set: { editing = $0 }),
                axis: .vertical
            )
            .lineLimit(2...8)
            .teInput()
            HStack(spacing: 14) {
                Button("Save") { Task { await save() } }
                    .disabled(busy || Comments.commentLength(draft) == 0
                        || Comments.commentLength(draft) > Comments.COMMENT_MAX_CHARS)
                    .foregroundStyle(Color(.accentInk))
                Button("Cancel") { editing = nil; error = nil }
                    .foregroundStyle(Color(.textMuted))
            }
            .teStyle(.sm)
            .buttonStyle(.plain)
        }
    }

    private func report() {
        if let url = Comments.reportURL(comment.id) { openURL(url) }
    }

    private func save() async {
        guard let text = editing?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            try await model.edit(comment.id, body: text)
            editing = nil
            error = nil
        } catch {
            self.error = Comments.commentError(error)
        }
    }

    private func delete() async {
        do {
            try await model.delete(comment.id)
        } catch {
            self.error = Comments.commentError(error)
        }
    }

    /// The block, through the same routes as the Coaching page.
    private func perform(_ block: CoachingModel.Confirmation) async {
        do {
            switch block {
            case .removeCoach(let id, _):
                try await auth.api.removeCoach(id: id)
                await model.load()
            case .leave(let id, _):
                try await auth.api.leaveStudent(id: id)
                router.dropStudent(id)
                router.show(.coaching)
            }
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}

// MARK: - The composer

/// A text box, an optional place, and Send. The typing lives on the router
/// (`AppRouter.heldFields`, keyed by the page's route and the target), so a
/// rotation across 840 pt — or a failed send — keeps it.
struct CommentComposer: View {
    let route: Route
    let key: String
    let placeholder: String
    let sendTitle: String
    /// The place attached, said — "in T4 · 1.2 km" — or nil.
    var place: String?
    var onClearPlace: (() -> Void)?
    /// *◆ At the marked place*, where there is a place to take.
    var onTakePlace: (() -> Void)?
    /// Send the text; answers an error to show, or nil once it is in.
    let send: (String) async -> String?

    @Environment(AppRouter.self) private var router
    @State private var busy = false
    @State private var error: String?

    private var text: Binding<String> {
        Binding(get: { router.heldText(route, key) }, set: { router.hold($0, key, route) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(placeholder, text: text, axis: .vertical)
                .lineLimit(2...8)
                .teInput()
                .accessibilityLabel(placeholder)
                .accessibilityIdentifier("commentField")
            HStack(spacing: 10) {
                if let place {
                    HStack(spacing: 4) {
                        Text("◆ \(place)")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.accentInk))
                        if let onClearPlace {
                            Button(action: onClearPlace) {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color(.textMuted))
                            .accessibilityLabel("Remove the place")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("commentPlace")
                } else if let onTakePlace {
                    Button("◆ At the marked place", action: onTakePlace)
                        .teStyle(.xs)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color(.accentInk))
                        .accessibilityIdentifier("commentTakePlace")
                }
                Spacer(minLength: 0)
                let count = Comments.commentLength(text.wrappedValue)
                if count > Comments.COMMENT_MAX_CHARS - 100 {
                    Text("\(count)/\(Comments.COMMENT_MAX_CHARS)")
                        .teStyle(.xs)
                        .foregroundStyle(count > Comments.COMMENT_MAX_CHARS ? Color(.dangerInk) : Color(.textMuted))
                }
                Button(sendTitle) { Task { await submit() } }
                    .teStyle(.sm)
                    .fontWeight(.semibold)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(.accentInk))
                    .disabled(busy || count == 0 || count > Comments.COMMENT_MAX_CHARS)
                    .accessibilityIdentifier("sendComment")
            }
            if let error {
                Text(error)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.dangerInk))
                    .accessibilityIdentifier("commentError")
            }
        }
    }

    private func submit() async {
        let body = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        busy = true
        defer { busy = false }
        if let failed = await send(body) {
            // The draft stays in the box, on the router, for another try.
            error = failed
        } else {
            error = nil
            router.hold("", key, route)
        }
    }
}

// MARK: - The lap page's card

/// The lap page's *Comments*: every thread's comments on this lap in place
/// order, a composer per open thread, and *◆ at …* from the lap stage's
/// playhead. A placed comment's *Show on lap* seeks the stage there.
struct LapCommentsCard: View {
    let model: CommentsModel
    let session: Session
    let lap: Lap
    /// The page's route — where the drafts are held.
    let route: Route
    /// The grid step of the session's channels, nil for a lap without them.
    var dStepM: Double?
    var corners: [Corners.Corner] = []
    /// Where the stage's playhead is on this lap, as a grid index — read on a
    /// tap only, so the card never re-renders with the video.
    var currentK: (() -> Double?)?
    /// Seek the stage to a grid index.
    var seek: ((Double) -> Void)?

    @Environment(\.unitSystem) private var units
    @State private var places: [Int: Int] = [:]
    @State private var placeHint: String?

    var body: some View {
        let threads = model.threads(sessionId: session.id)
        TECard {
            VStack(alignment: .leading, spacing: 12) {
                Text(Comments.COMMENTS_HEADING)
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textMuted))
                    .accessibilityAddTraits(.isHeader)
                if threads.isEmpty {
                    Text("No comments on this lap.")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textFaint))
                }
                ForEach(threads, id: \.coachId) { thread in
                    threadView(thread)
                }
                if let placeHint {
                    Text(placeHint)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
            }
        }
        // A container, so the identifier doesn't stamp itself over the
        // composer's and the cards' own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lapComments")
    }

    @ViewBuilder
    private func threadView(_ thread: Comments.Thread) -> some View {
        let onLap = Comments.groupComments(thread.comments, session).laps.first { $0.lapId == lap.id }?.comments ?? []
        let open = model.isOpen(thread)
        VStack(alignment: .leading, spacing: 8) {
            Text(Comments.threadTitle(model.coach(thread.coachId), model.isOwner))
                .teStyle(.sm)
                .fontWeight(.semibold)
                .foregroundStyle(Color(.textStrong))
            if !model.isOwner && thread.comments.isEmpty {
                Text(Comments.coachAudienceNote(model.owner.displayName))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            ForEach(onLap) { comment in
                CommentCard(
                    comment: comment, model: model, place: place(comment.distM),
                    onShow: showAction(comment), onReply: nil
                )
            }
            if open {
                CommentComposer(
                    route: route, key: "comment.lap.\(lap.id).\(thread.coachId)",
                    placeholder: model.isOwner ? Comments.REPLY_PLACEHOLDER : Comments.COMMENT_PLACEHOLDER,
                    sendTitle: model.isOwner ? "Reply" : "Comment",
                    place: places[thread.coachId].flatMap { place(Double($0)) },
                    onClearPlace: { places[thread.coachId] = nil },
                    onTakePlace: currentK == nil ? nil : { takePlace(thread.coachId) }
                ) { body in
                    do {
                        try await model.send(
                            sessionId: session.id, coachId: thread.coachId, body: body,
                            lapId: lap.id, distM: places[thread.coachId]
                        )
                        places[thread.coachId] = nil
                        return nil
                    } catch {
                        return Comments.commentError(error)
                    }
                }
                if model.asksForPush(thread) {
                    PushAskCard(name: model.pushAskName(thread))
                }
            } else {
                Text(Comments.THREAD_CLOSED)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }

    private func place(_ distM: Int?) -> String? {
        distM.flatMap { place(Double($0)) }
    }

    private func place(_ distM: Double) -> String? {
        Comments.commentPlace(distM, dStepM, corners, units)
    }

    private func showAction(_ comment: CoachComment) -> (() -> Void)? {
        guard let distM = comment.distM, let dStepM, dStepM > 0, let seek else { return nil }
        return { seek(Double(distM) / dStepM) }
    }

    private func takePlace(_ coachId: Int) {
        guard let k = currentK?(), let distM = Comments.placeFromCursor(k, dStepM) else {
            placeHint = "Play or scrub the video, or tap a chart, to mark a place first."
            return
        }
        placeHint = nil
        places[coachId] = distM
    }
}

// MARK: - The event page

/// A session's comments on the event page: each thread's session-level
/// comments, and the door to say something about the session — the pushed
/// `SessionCommentScreen`, since the page's one `.sheet` is taken. Lap-level
/// comments live on their lap's page; the lap rows carry their count.
struct SessionCommentsBlock: View {
    let model: CommentsModel
    let session: Session

    @Environment(AppRouter.self) private var router

    var body: some View {
        let threads = model.threads(sessionId: session.id)
        if model.loaded, !threads.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(Comments.COMMENTS_HEADING)
                    .teStyle(.eyebrow)
                    .foregroundStyle(Color(.textMuted))
                    .accessibilityAddTraits(.isHeader)
                ForEach(threads, id: \.coachId) { thread in
                    threadView(thread)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("sessionComments-\(session.id)")
        }
    }

    @ViewBuilder
    private func threadView(_ thread: Comments.Thread) -> some View {
        let grouped = Comments.groupComments(thread.comments, session)
        let open = model.isOpen(thread)
        let lapCount = grouped.laps.reduce(0) { $0 + $1.comments.count }
        VStack(alignment: .leading, spacing: 8) {
            Text(Comments.threadTitle(model.coach(thread.coachId), model.isOwner))
                .teStyle(.sm)
                .fontWeight(.semibold)
                .foregroundStyle(Color(.textStrong))
            if !model.isOwner && thread.comments.isEmpty {
                Text(Comments.coachAudienceNote(model.owner.displayName))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            ForEach(grouped.session) { comment in
                CommentCard(
                    comment: comment, model: model, place: nil, onShow: nil,
                    onReply: open && !comment.mine ? { compose(thread) } : nil
                )
            }
            if lapCount > 0 {
                Text("\(Comments.commentCountText(.init(count: lapCount, unread: 0))) on laps — open a lap to read them.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            if open {
                Button(model.isOwner ? "Reply about the session" : "Comment on the session") { compose(thread) }
                    .teStyle(.sm)
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(.accentInk))
                    .accessibilityIdentifier("commentOnSession-\(session.id)")
                if model.asksForPush(thread) {
                    PushAskCard(name: model.pushAskName(thread))
                }
            } else {
                Text(Comments.THREAD_CLOSED)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }

    private func compose(_ thread: Comments.Thread) {
        router.push(model.owner.link(.sessionComment(
            eventId: model.eventId, sessionId: session.id, coachId: model.isOwner ? thread.coachId : nil
        )))
    }
}

// MARK: - The session form

/// A comment on a whole session, as a pushed page: the event page already
/// presents its one `.sheet`. The thread's session-level comments above the
/// composer, so a reply is written with what it answers in view; a send goes
/// back to the event.
struct SessionCommentScreen: View {
    let eventId: Int
    let sessionId: Int
    /// The thread an owner replies into; nil for a coach, whose own it is.
    let coachId: Int?

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.logbookOwner) private var owner
    @Environment(\.dismiss) private var dismiss
    @State private var event: EventModel?
    @State private var comments: CommentsModel?

    private var route: Route {
        owner.link(.sessionComment(eventId: eventId, sessionId: sessionId, coachId: coachId))
    }

    var body: some View {
        TELoadable(state: event?.state ?? .loading, retry: { await event?.load() }) {
            if let event, let comments, let session = event.detail?.sessions.first(where: { $0.id == sessionId }) {
                content(comments, session)
            } else if event?.detail != nil {
                TEPage { TEEmpty("This session is no longer in the logbook.") }
            }
        }
        .background(Color(.bgPage))
        .navigationTitle("Comment")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard event == nil else { return }
            let event = EventModel(api: auth.api.scoped(to: owner), eventId: eventId)
            let comments = CommentsModel(api: auth.api, owner: owner, eventId: eventId, viewerId: auth.me?.user.id)
            self.event = event
            self.comments = comments
            async let read: Void = event.load()
            await comments.load()
            await read
            await auth.noteCommentsSeen(await comments.markSeen())
        }
    }

    private func content(_ comments: CommentsModel, _ session: Session) -> some View {
        let thread = comments.threads(sessionId: sessionId).first { coachId == nil || $0.coachId == coachId }
            ?? Comments.Thread(coachId: coachId ?? comments.viewerId ?? 0, comments: [])
        let said = Comments.groupComments(thread.comments, session).session
        return TEPage {
            Text(session.label ?? "Session")
                .teStyle(.h2)
                .foregroundStyle(Color(.textStrong))
            Text(Comments.threadTitle(comments.coach(thread.coachId), comments.isOwner))
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
            if !comments.isOwner {
                Text(Comments.coachAudienceNote(owner.displayName))
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            ForEach(said) { comment in
                CommentCard(comment: comment, model: comments, place: nil, onShow: nil, onReply: nil)
            }
            if comments.isOpen(thread) {
                TECard {
                    CommentComposer(
                        route: route, key: "comment",
                        placeholder: comments.isOwner ? Comments.REPLY_PLACEHOLDER : Comments.COMMENT_PLACEHOLDER,
                        sendTitle: comments.isOwner ? "Reply" : "Comment"
                    ) { body in
                        do {
                            try await comments.send(
                                sessionId: sessionId, coachId: thread.coachId, body: body, lapId: nil, distM: nil
                            )
                            dismiss()
                            return nil
                        } catch {
                            return Comments.commentError(error)
                        }
                    }
                }
            } else {
                Text(Comments.THREAD_CLOSED)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }
        }
    }
}

// MARK: - Unread

/// Unread coach comments, in one place (NS-52): the count and the feed
/// (`GET /coaching/comments`) that the dashboard's card, Settings' Coaching row
/// and the Coaching page all read. One value rather than a copy per screen,
/// because at expanded width the dashboard stays in the list pane while a
/// thread is read beside it — a copy it fetched on load went on saying
/// "3 new comments" after they had been read (the bug Android shipped first).
///
/// A successful `/seen` lowers the count at once and reads the feed again; the
/// account's `/me` sets the count whenever it arrives. The fetch is injected,
/// so the rules are tested without a server (`CommentInboxTests`).
@MainActor
@Observable
final class CommentInbox {
    private(set) var feed: CommentFeed?
    private(set) var unread = 0
    private let fetch: () async throws -> CommentFeed

    init(fetch: @escaping () async throws -> CommentFeed) {
        self.fetch = fetch
    }

    func setUnread(_ count: Int) {
        unread = max(0, count)
    }

    /// Read the feed; a failure keeps what was there.
    func refresh() async {
        guard let fresh = try? await fetch() else { return }
        feed = fresh
        unread = fresh.unread
    }

    /// `seen` comments were just marked read on the server.
    func seen(_ seen: Int) async {
        guard seen > 0 else { return }
        unread = max(0, unread - seen)
        await refresh()
    }

    func clear() {
        feed = nil
        unread = 0
    }
}

/// What was said to you, as a dashboard card while anything is unread: the
/// comment itself when there is one, the count and the Coaching page when
/// there are more — the web's `commentsCardHtml`.
struct UnreadCommentsCard: View {
    let feed: CommentFeed
    let open: (Route) -> Void

    var body: some View {
        if let line = Comments.unreadLine(feed) {
            let unread = feed.comments.filter { !$0.seen }
            let single = feed.unread == 1 && unread.count == 1 ? unread.first : nil
            Button {
                open(single.map(Self.route(for:)) ?? .coaching)
            } label: {
                TECard {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("💬 \(line)")
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.textStrong))
                        if let single {
                            Text(single.body)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textBody))
                                .lineLimit(3)
                        }
                        Text(single == nil ? "See them all →" : "Open →")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.accentInk))
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("unreadComments")
        }
    }

    /// Where a feed row opens: the lap when it is about one, else the event —
    /// in whichever logbook it is.
    static func route(for row: CommentFeed.Row) -> Route {
        let owner: LogbookOwner = row.student.map { .student(id: $0.id, name: $0.name, pro: false) } ?? .me
        if let lapId = row.lapId {
            return owner.link(.lap(eventId: row.eventId, sessionId: row.sessionId, lapId: lapId))
        }
        return owner.link(.event(row.eventId))
    }
}
