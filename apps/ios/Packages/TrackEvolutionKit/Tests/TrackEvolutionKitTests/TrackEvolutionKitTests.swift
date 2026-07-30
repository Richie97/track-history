import Foundation
import Testing

@testable import TrackEvolutionKit

@Test func defaultBaseURLIsTheHostedInstance() {
    #expect(TrackEvolutionKit.defaultBaseURL.absoluteString == "https://trackevolution.app")
}

@Test func callbackSchemeMatchesTheInfoPlistURLType() {
    // Kept in lockstep with CFBundleURLTypes in apps/ios/App/Info.plist and the
    // `trackevolution://auth` redirect in src/routes/auth.ts.
    #expect(TrackEvolutionKit.callbackScheme == "trackevolution")
}
