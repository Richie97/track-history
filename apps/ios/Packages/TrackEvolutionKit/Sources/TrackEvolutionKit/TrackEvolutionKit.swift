import Foundation

/// Namespace for module-wide constants. The real types land in later specs:
/// domain models and the API client in NS-04, the recorder core in NS-11, lap
/// geometry in NS-13, the offline store in NS-21.
public enum TrackEvolutionKit {
    /// Default backend. Overridable at runtime (the app's server setting points
    /// dev builds at `npm run dev` on the LAN), which is why it lives here
    /// rather than being hard-coded at the call sites.
    public static let defaultBaseURL = URL(string: "https://trackevolution.app")!

    /// Custom URL scheme the OAuth callback redirects to (`trackevolution://auth`).
    /// Must match `CFBundleURLTypes` in the app's Info.plist and the scheme the
    /// Worker's `?client=app` auth flow redirects to.
    public static let callbackScheme = "trackevolution"
}
