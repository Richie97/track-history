import SwiftUI
import TrackEvolutionKit

/// Settings → AI assistants → **AI Coach** (#320): a key per provider, which one
/// the AI Coach uses, Verify, Forget, the model field, and where the key lives.
/// The web's `drawAiCoachSettings`; separate from Coaching, which is people.
///
/// A free account sees the Pro offer instead (a 402 is an offer, not an
/// error). The model field is a type-ahead over the models the driver's own
/// account lists (verify reads the provider's models API): the stored list
/// shows at once, the first focus re-reads it, a typed id that is not listed
/// is allowed, and empty means the provider's default.
struct AICoachSettingsCard: View {
    @Environment(AuthController.self) private var auth

    var body: some View {
        if Entitlement.canUseAICoach(auth.entitlement) {
            TECard {
                VStack(alignment: .leading, spacing: 14) {
                    Text("A debrief of a session, two laps or a track day, on your own Anthropic or OpenAI account.")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textMuted))
                    ForEach(AICoach.COACH_PROVIDERS, id: \.id) { provider in
                        AICoachProviderRow(provider: provider)
                        if provider.id != AICoach.COACH_PROVIDERS.last?.id {
                            Divider().overlay(Color(.borderHairline))
                        }
                    }
                    Text("Stored on this device only, in its Keychain, and sent with each \(AICoach.COACH_NAME) request — never stored on our servers, and not included in backups. You pay Anthropic or OpenAI directly for what the \(AICoach.COACH_NAME) uses.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                        .accessibilityIdentifier("aiCoachKeyNote")
                }
            }
        } else {
            ProUpsellCard(title: AICoach.COACH_NAME, blurb: AICoach.COACH_PRO_WHAT)
        }
    }
}

private struct AICoachProviderRow: View {
    let provider: AICoach.Provider

    @Environment(AuthController.self) private var auth
    @State private var key = ""
    @State private var model = ""
    @State private var verifying = false
    @State private var message: String?
    @State private var refreshed = false
    @FocusState private var modelFocused: Bool

    private var store: AICoachStore { auth.aiCoach }
    private var entry: AICoachStore.Entry? { store.keys[provider.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    store.setActive(provider.id)
                } label: {
                    Image(systemName: store.activeId == provider.id ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(entry == nil ? Color(.textFaint) : Color(.accentInk))
                }
                .buttonStyle(.plain)
                .disabled(entry == nil)
                .accessibilityLabel("Use \(provider.name)")
                .accessibilityAddTraits(store.activeId == provider.id ? .isSelected : [])
                .accessibilityIdentifier("aiCoachActive-\(provider.id)")
                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.name)
                        .teStyle(.bodyStrong)
                        .foregroundStyle(Color(.textStrong))
                    Text(entry.map { "key \(AICoachStore.maskKey($0.key)) · stored on this device" } ?? "no key yet")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                }
            }
            if let entry {
                TEField(label: "Model") {
                    TextField(AICoach.modelPlaceholder(entry.defaultModel), text: $model)
                        .teInput()
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($modelFocused)
                        .submitLabel(.done)
                        .onSubmit(commitModel)
                        .accessibilityIdentifier("aiCoachModel-\(provider.id)")
                }
                if modelFocused {
                    suggestions(entry)
                }
                Text("Start typing to pick from the models your \(provider.name) account offers, or leave it empty for the default.")
                    .teStyle(.xs)
                    .foregroundStyle(Color(.textFaint))
                Button("Forget key") {
                    store.forget(provider.id)
                    model = ""
                    message = nil
                }
                .buttonStyle(TEButtonStyle(kind: .quiet))
                .accessibilityIdentifier("aiCoachForget-\(provider.id)")
            } else {
                SecureField(provider.placeholder, text: $key)
                    .teInput()
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("\(provider.name) API key")
                    .accessibilityIdentifier("aiCoachKey-\(provider.id)")
                HStack(spacing: 10) {
                    Button(verifying ? "Checking…" : "Verify") {
                        Task { await verify() }
                    }
                    .buttonStyle(TEButtonStyle(kind: .accent))
                    .disabled(verifying || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("aiCoachVerify-\(provider.id)")
                    if let url = URL(string: provider.keyUrl) {
                        Link("Get a key ↗", destination: url)
                            .teStyle(.sm)
                            .tint(Color(.accentInk))
                    }
                }
            }
            if let message {
                Text(message)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.dangerInk))
                    .accessibilityIdentifier("aiCoachMessage-\(provider.id)")
            }
        }
        .onAppear { model = entry?.model ?? "" }
        .onChange(of: modelFocused) { _, focused in
            if focused, !refreshed {
                refreshed = true
                Task { await store.refreshModels(provider.id, api: auth.api) }
            } else if !focused {
                commitModel()
            }
        }
    }

    /// The listed models matching what is typed — the web's `<datalist>`.
    @ViewBuilder
    private func suggestions(_ entry: AICoachStore.Entry) -> some View {
        let typed = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matches = entry.models.filter {
            typed.isEmpty || $0.id.lowercased().contains(typed) || $0.label.lowercased().contains(typed)
        }.prefix(8)
        if !matches.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(matches), id: \.id) { option in
                    Button {
                        model = option.id
                        modelFocused = false
                    } label: {
                        HStack {
                            Text(verbatim: option.id)
                                .teStyle(.sm)
                                .foregroundStyle(Color(.textStrong))
                            Spacer()
                            if option.label != option.id {
                                Text(verbatim: option.label)
                                    .teStyle(.xs)
                                    .foregroundStyle(Color(.textMuted))
                            }
                        }
                        .padding(.vertical, 8)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func commitModel() {
        guard let entry else { return }
        let picked = AICoach.resolveModelInput(model, entry.models)
        model = picked ?? ""
        store.setModel(provider.id, picked)
    }

    private func verify() async {
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return }
        verifying = true
        message = nil
        defer { verifying = false }
        switch await auth.api.verifyAICoachKey(provider: provider.id, key: typed) {
        case .ok(let verify):
            store.save(provider.id, key: typed, verify: verify)
            key = ""
            model = ""
        case .failed(_, let error):
            message = error
        }
    }
}
