import SwiftUI
import TrackEvolutionKit

/// The driver-profile form (NS-38) — `viewProfile` in `public/app.js`, built
/// from the Kit's `DriverProfile.PROFILE_GROUPS` so the three clients render
/// one field spec. Every field is optional and the server validates; each
/// yes/no is a three-way picker, because an unticked box would answer a
/// question the driver never did.
///
/// The typing is held on the router, keyed by this route, like the event form's
/// draft — crossing 840pt swaps the shell and would otherwise drop it (epic
/// #277, ticket 1).
struct ProfileFormScreen: View {
    @Environment(AuthController.self) private var auth
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    @State private var state: LoadState = .loading
    @State private var values: [String: String] = [:]
    @State private var stored: DriverProfile?
    @State private var isSaving = false
    @State private var error: String?
    @State private var confirmingClear = false

    private static let draftKey = "draft"

    var body: some View {
        TELoadable(state: state, retry: load) {
            form
        }
        .navigationTitle("Driver profile")
        .navigationBarTitleDisplayMode(.inline)
        .task { if state == .loading { await load() } }
        .onChange(of: values) { _, next in hold(next) }
        .confirmationDialog(
            "Clear your whole driver profile?",
            isPresented: $confirmingClear,
            titleVisibility: .visible
        ) {
            Button("Clear profile", role: .destructive) { Task { await save(nil) } }
            Button("Keep it", role: .cancel) {}
        }
    }

    private var form: some View {
        TEPage {
            Text("""
                What the coaches you've invited see about you. Only you and them — it's never on your share page \
                or the leaderboards. There's no birth date or emergency contact here on purpose: tell your \
                instructor those at the track.
                """)
                .teStyle(.xs)
                .foregroundStyle(Color(.textMuted))
                .fixedSize(horizontal: false, vertical: true)

            ForEach(DriverProfile.PROFILE_GROUPS, id: \.title) { group in
                TESectionHeader(group.title)
                TECard {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(group.fields, id: \.key) { field in
                            fieldView(field)
                        }
                    }
                }
            }

            if let error {
                TEErrorBanner(message: error)
            }

            Button(isSaving ? "Saving…" : "Save profile") {
                Task { await save(DriverProfile.profileBody(values.mapValues { .string($0) })) }
            }
            .buttonStyle(TEButtonStyle(kind: .accent))
            .disabled(isSaving)
            .accessibilityIdentifier("saveProfile")

            if stored != nil {
                Button("Clear profile") { confirmingClear = true }
                    .buttonStyle(TEButtonStyle(kind: .danger))
                    .disabled(isSaving)
            }
        }
    }

    @ViewBuilder
    private func fieldView(_ field: DriverProfile.Field) -> some View {
        let text = binding(field)
        TEField(label: field.label) {
            switch field.kind {
            case .text:
                TextField(field.placeholder ?? "", text: text)
                    .teInput()
                    .accessibilityIdentifier("profile-\(field.key)")
            case .long:
                TextField(field.placeholder ?? "", text: text, axis: .vertical)
                    .teInput()
                    .lineLimit(2...6)
                    .accessibilityIdentifier("profile-\(field.key)")
            case .year:
                TextField(field.placeholder ?? "", text: text)
                    .teInput()
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("profile-\(field.key)")
            case .select:
                Picker(field.label, selection: text) {
                    Text("—").tag("")
                    ForEach(field.options ?? [], id: \.self) { option in
                        Text(option.last ?? "").tag(option.first ?? "")
                    }
                }
                .pickerStyle(.menu)
                .tint(Color(.textStrong))
                .accessibilityIdentifier("profile-\(field.key)")
            case .bool:
                Picker(field.label, selection: text) {
                    Text("—").tag("")
                    Text("Yes").tag("yes")
                    Text("No").tag("no")
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("profile-\(field.key)")
            }
        }
    }

    /// A field's text, capped at the server's length so a save isn't refused
    /// for a limit the form could have kept.
    private func binding(_ field: DriverProfile.Field) -> Binding<String> {
        Binding(
            get: { values[field.key] ?? "" },
            set: { next in
                if let max = field.max, next.count > max {
                    values[field.key] = String(next.prefix(max))
                } else {
                    values[field.key] = next
                }
            }
        )
    }

    /// A stored profile as the form's raw values — the reverse of `profileBody`.
    static func formValues(_ profile: DriverProfile?) -> [String: String] {
        var out: [String: String] = [:]
        guard let profile else { return out }
        for field in DriverProfile.PROFILE_FIELDS {
            switch profile.value(for: field.key) {
            case .text(let s): out[field.key] = s
            case .number(let n): out[field.key] = String(n)
            case .bool(let b): out[field.key] = b ? "yes" : "no"
            case nil: break
            }
        }
        return out
    }

    private func hold(_ values: [String: String]) {
        guard state == .ready,
              let data = try? JSONEncoder().encode(values),
              let json = String(data: data, encoding: .utf8) else { return }
        router.hold(json, Self.draftKey, .profile)
    }

    private func load() async {
        do {
            stored = try await auth.api.profile().profile
            // A draft typed before the shell swap wins over the stored copy.
            let held = router.heldText(.profile, Self.draftKey)
            if let data = held.data(using: .utf8),
               let restored = try? JSONDecoder().decode([String: String].self, from: data) {
                values = restored
            } else {
                values = Self.formValues(stored)
            }
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func save(_ profile: DriverProfile?) async {
        error = nil
        isSaving = true
        defer { isSaving = false }
        do {
            try await auth.api.saveProfile(profile)
            router.hold("", Self.draftKey, .profile)
            Haptics.confirm()
            dismiss()
        } catch let error as APIError {
            self.error = error.message
            Haptics.warn()
        } catch {
            self.error = error.localizedDescription
            Haptics.warn()
        }
    }
}
