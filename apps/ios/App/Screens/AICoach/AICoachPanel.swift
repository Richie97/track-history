import SwiftUI
import TrackEvolutionKit

/// What an entry point opens the AI Coach with: where it was opened from, the
/// subtitle, and how a kept reply is written into the notes it belongs to —
/// the session's for a debrief, an event's otherwise — through the ordinary,
/// free, queueable notes write.
struct AICoachLaunch: Identifiable {
    let id = UUID()
    let entry: AICoach.Entry
    let context: AICoach.Context
    let subtitle: String
    /// Appends a reply to the notes; throws the server's message.
    let save: @MainActor (String) async throws -> Void
}

/// One AI Coach conversation (#320): the web's drawer state. The conversation
/// lives here and is sent whole each time — the server keeps nothing.
///
/// A failed question leaves the conversation (so *Try again* asks it afresh);
/// a 402 is the Pro offer in place, never an error; a 401 signs out.
@MainActor
@Observable
final class AICoachConversation {
    struct Turn: Identifiable {
        let id = UUID()
        let question: String
        var reply = ""
        /// The tool label while it works; nil once it has finished.
        var progress: String? = "Thinking…"
        /// Why it stopped short (`done`'s `message`).
        var stopMessage: String?
        /// The refusal, in words, when it failed — with whether Settings is the fix.
        var failure: String?
        var failureNeedsSettings = false
        var finished = false
        var saved = false
        var saveError: String?
    }

    let launch: AICoachLaunch
    private let api: APIClient
    private let store: AICoachStore
    private let onUnauthorized: @MainActor () -> Void

    private(set) var turns: [Turn] = []
    private(set) var messages: [AICoachMessage] = []
    private(set) var busy = false
    /// A 402 (or a free account): the Pro offer takes the panel.
    private(set) var paywall: Bool
    private var running: Task<Void, Never>?

    init(
        launch: AICoachLaunch, api: APIClient, store: AICoachStore, entitlement: Entitlement?,
        onUnauthorized: @escaping @MainActor () -> Void
    ) {
        self.launch = launch
        self.api = api
        self.store = store
        self.onUnauthorized = onUnauthorized
        self.paywall = !Entitlement.canUseAICoach(entitlement)
    }

    var provider: String? { store.credential?.provider }

    /// The opening question, once.
    func start() {
        guard turns.isEmpty, !paywall else { return }
        ask(AICoach.entry(launch.entry).question)
    }

    func stop() {
        running?.cancel()
        running = nil
    }

    func ask(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !busy, !paywall, let credential = store.credential else { return }
        busy = true
        turns.append(Turn(question: question))
        let index = turns.count - 1
        messages.append(AICoachMessage(role: .user, content: question))
        let request = AICoachRequest(context: launch.context, messages: messages, model: credential.model)
        running = Task { [weak self] in
            guard let self else { return }
            var outcome: AICoachOutcome?
            for await event in await api.aiCoach(request, credential: credential) {
                switch event {
                case .text(let delta): turns[index].reply += delta
                case .tool(_, let label): turns[index].progress = (label?.isEmpty == false ? label : nil) ?? "Reading your logbook…"
                case .finished(let end): outcome = end
                }
            }
            finish(index, outcome, provider: credential.provider)
        }
    }

    private func finish(_ index: Int, _ outcome: AICoachOutcome?, provider: String) {
        busy = false
        running = nil
        turns[index].progress = nil
        turns[index].finished = true
        switch outcome {
        case .done(_, let message):
            let reply = turns[index].reply
            if reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // Nothing came back, so the question leaves the conversation too.
                messages.removeLast()
            } else {
                messages.append(AICoachMessage(role: .assistant, content: reply))
            }
            turns[index].stopMessage = message
        case .paywall:
            messages.removeLast()
            paywall = true
        case .unauthorized:
            messages.removeLast()
            onUnauthorized()
        case .error(let status, let error):
            messages.removeLast()
            turns[index].failure = AICoach.coachErrorText(status, error, provider)
            turns[index].failureNeedsSettings = status == 424 || status == 400
        case .offline:
            messages.removeLast()
            turns[index].failure = "The \(AICoach.COACH_NAME) \(AICoach.COACH_OFFLINE)."
        case nil:
            // Cancelled: the sheet closed while it was answering.
            messages.removeLast()
        }
    }

    /// Ask a failed question again, in its place.
    func retry(_ turn: Turn) {
        guard !busy, let index = turns.firstIndex(where: { $0.id == turn.id }) else { return }
        turns.remove(at: index)
        ask(turn.question)
    }

    func save(_ turn: Turn) async {
        guard let index = turns.firstIndex(where: { $0.id == turn.id }) else { return }
        turns[index].saveError = nil
        do {
            try await launch.save(turn.reply)
            turns[index].saved = true
        } catch let error as APIError {
            turns[index].saveError = error.message
        } catch {
            turns[index].saveError = error.localizedDescription
        }
    }
}

/// The AI Coach itself: the streamed reply, tool progress, follow-ups, *Try
/// again*, *Save to notes* — or the Pro offer. The same view is the sheet on a
/// phone and the event page's side column at expanded width.
///
/// A reply is drawn from ``AICoach/coachMarkdownBlocks(_:)`` and
/// ``AICoach/coachBoldRuns(_:)`` as plain `Text`: paragraphs, lists and bold,
/// and nothing a model writes is ever a link or markup. Never
/// `AttributedString(markdown:)` on model text — that would make links live.
struct AICoachPanel: View {
    let conversation: AICoachConversation
    /// Close the sheet or the column.
    let onClose: () -> Void
    /// Leave for Settings' AI Coach block (no key, or a key refused).
    let onOpenSettings: () -> Void

    @State private var followUp = ""
    @FocusState private var typing: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Color(.borderHairline))
            if conversation.paywall {
                ScrollView {
                    ProUpsellCard(title: AICoach.COACH_NAME, blurb: AICoach.COACH_PRO_WHAT)
                        .padding(TESpacing.pageGutter)
                }
            } else {
                log
                Divider().overlay(Color(.borderHairline))
                askRow
                Text("Runs on your \(AICoach.providerName(conversation.provider)) account. \(AICoach.COACH_DISCLAIMER)")
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, TESpacing.pageGutter)
                    .padding(.bottom, 10)
                    .accessibilityIdentifier("aiCoachFooter")
            }
        }
        .background(Color(.bgPage))
        .onAppear { conversation.start() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("aiCoachPanel")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(AICoach.COACH_NAME)
                    .teStyle(.h3)
                    .foregroundStyle(Color(.textStrong))
                Text(conversation.launch.subtitle)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .lineLimit(2)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color(.textMuted))
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close the \(AICoach.COACH_NAME)")
            .accessibilityIdentifier("aiCoachClose")
        }
        .padding(.horizontal, TESpacing.pageGutter)
        .padding(.vertical, 6)
    }

    private var log: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(conversation.turns) { turn in
                        turnView(turn).id(turn.id)
                    }
                }
                .padding(TESpacing.pageGutter)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: conversation.turns.last?.reply) { _, _ in
                if let last = conversation.turns.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
            .onChange(of: conversation.turns.count) { _, _ in
                if let last = conversation.turns.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    @ViewBuilder
    private func turnView(_ turn: AICoachConversation.Turn) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(turn.question)
                .teStyle(.sm)
                .foregroundStyle(Color(.textBody))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.sm))
            if let progress = turn.progress {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(progress)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("aiCoachProgress")
            }
            if !turn.reply.isEmpty {
                AICoachReply(text: turn.reply)
                    // One element, read as the whole reply.
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("aiCoachReply")
            } else if turn.finished, turn.failure == nil {
                Text("The \(AICoach.COACH_NAME) had nothing to add.")
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
            }
            if let message = turn.stopMessage {
                Text(message)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
            }
            if let failure = turn.failure {
                TEErrorBanner(message: failure)
                    .accessibilityIdentifier("aiCoachError")
                HStack(spacing: 8) {
                    Button("Try again") { conversation.retry(turn) }
                        .buttonStyle(TEButtonStyle(kind: .quiet))
                        .disabled(conversation.busy)
                        .accessibilityIdentifier("aiCoachRetry")
                    if turn.failureNeedsSettings {
                        Button("Open Settings", action: onOpenSettings)
                            .buttonStyle(TEButtonStyle(kind: .quiet))
                            .accessibilityIdentifier("aiCoachSettings")
                    }
                }
            } else if turn.finished, !turn.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                saveRow(turn)
            }
        }
    }

    @ViewBuilder
    private func saveRow(_ turn: AICoachConversation.Turn) -> some View {
        HStack(spacing: 10) {
            if turn.saved {
                Label("Saved to notes.", systemImage: "checkmark")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textMuted))
                    .accessibilityIdentifier("aiCoachSaved")
            } else {
                Button(AICoach.coachSaveLabel(conversation.launch.entry)) {
                    Task { await conversation.save(turn) }
                }
                .buttonStyle(TEButtonStyle(kind: .quiet))
                .accessibilityIdentifier("aiCoachSave")
            }
            if let error = turn.saveError {
                Text(error)
                    .teStyle(.xs)
                    .foregroundStyle(Color(.dangerInk))
            }
        }
    }

    private var askRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask a follow-up…", text: $followUp, axis: .vertical)
                .lineLimit(1...4)
                .teInput()
                .focused($typing)
                .submitLabel(.send)
                .onSubmit(send)
                .accessibilityIdentifier("aiCoachFollowUp")
            Button("Send", action: send)
                .teStyle(.bodyStrong)
                .foregroundStyle(Color(.accentInk))
                .disabled(conversation.busy || followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.bottom, 10)
                .accessibilityIdentifier("aiCoachSend")
        }
        .padding(.horizontal, TESpacing.pageGutter)
        .padding(.vertical, 10)
    }

    private func send() {
        let text = String(followUp.prefix(4000))
        guard !conversation.busy, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        followUp = ""
        conversation.ask(text)
    }
}

/// A reply as paragraphs, lists and bold — the web's `coachMarkdownHtml`, drawn
/// as `Text`. Concatenated `Text` runs, never parsed Markdown: a link a model
/// writes stays the characters it is.
struct AICoachReply: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(AICoach.coachMarkdownBlocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .p(let lines):
                    Self.inline(lines.joined(separator: "\n"))
                case .h(let heading):
                    Text(verbatim: heading).bold()
                case .ul(let items):
                    list(items) { _ in "•" }
                case .ol(let items):
                    list(items) { "\($0 + 1)." }
                }
            }
        }
        .teStyle(.sm)
        .foregroundStyle(Color(.textBody))
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func list(_ items: [String], marker: @escaping (Int) -> String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: marker(index))
                        .foregroundStyle(Color(.textMuted))
                    Self.inline(item)
                }
            }
        }
    }

    /// Bold runs concatenated — `Text(verbatim:)` so nothing in the run is read
    /// as Markdown or a localisation key.
    static func inline(_ line: String) -> Text {
        line.split(separator: "\n", omittingEmptySubsequences: false).enumerated().reduce(Text(verbatim: "")) { text, pair in
            let runs = AICoach.coachBoldRuns(String(pair.element)).reduce(Text(verbatim: "")) { acc, run in
                acc + (run.bold ? Text(verbatim: run.text).bold() : Text(verbatim: run.text))
            }
            return pair.offset == 0 ? text + runs : text + Text(verbatim: "\n") + runs
        }
    }
}

/// An entry point's button: nothing in a read-only view (the caller's check),
/// disabled offline with "needs a connection". With no key it goes to
/// Settings' AI Coach block instead of opening a dead panel; a free account
/// gets the panel, with the Pro offer in it.
struct AICoachButton: View {
    let entry: AICoach.Entry
    var prominent = false
    let open: () -> Void

    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(RecordingController.self) private var recorder

    var body: some View {
        let store = auth.aiCoach
        // Never in the car: nothing while a recording runs (CarPlay has no
        // surface at all).
        if !recorder.isRecording {
            Button {
                if Entitlement.canUseAICoach(auth.entitlement), store.credential == nil {
                    store.focusSettings = true
                    router.push(.settings)
                } else {
                    open()
                }
            } label: {
                Label {
                    Text(AICoach.entry(entry).button + (store.offline ? " · \(AICoach.COACH_OFFLINE)" : ""))
                } icon: {
                    Image(systemName: "sparkles")
                }
            }
            .buttonStyle(TEButtonStyle(kind: prominent ? .accent : .quiet))
            .disabled(store.offline)
            .accessibilityIdentifier("aiCoach-\(entry.rawValue)")
        }
    }
}

/// The sheet form: one presentation, hung off a button by the page that opens it.
struct AICoachSheet: View {
    let conversation: AICoachConversation
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router

    var body: some View {
        AICoachPanel(
            conversation: conversation,
            onClose: { dismiss() },
            onOpenSettings: {
                auth.aiCoach.focusSettings = true
                dismiss()
                router.push(.settings)
            }
        )
        .onDisappear { conversation.stop() }
        .presentationDetents([.large])
    }
}
