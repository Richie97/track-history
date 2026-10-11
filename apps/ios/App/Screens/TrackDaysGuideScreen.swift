import SwiftUI
import UIKit
import WebKit

/// *Your first track day* — `site/docs/track-days.html` — read inside the app
/// rather than in Safari, from the dashboard's first-run card and from Settings.
///
/// The page is the docs site's, so it stays the one place the organizer list is
/// maintained. What the app changes is the frame around it (`GuidePage`): the
/// site's own header, sidebar, pager and footer are hidden, since this screen's
/// navigation bar does their job, and the web view marks itself in the user
/// agent so `site/analytics.js` loads nothing — the app reports this screen by
/// its route like any other. A link off the docs site, which is every
/// organizer's, opens in the browser: those are sites to sign up on, and a
/// sign-up belongs where the driver's passwords are.
struct TrackDaysGuideScreen: View {
    @State private var loading = true
    @State private var failure: String?
    /// Bumped by *Try again*, which builds a fresh web view.
    @State private var attempt = 0

    var body: some View {
        ZStack {
            Color(.bgPage).ignoresSafeArea()
            if let failure {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        TEEmpty(title: "Couldn't open the guide", failure)
                        TERetryButton {
                            self.failure = nil
                            loading = true
                            attempt += 1
                        }
                    }
                    .padding(TESpacing.pageGutter)
                }
            } else {
                GuideWebView(url: SettingsScreen.trackDaysGuideURL, loading: $loading, failure: $failure)
                    .id(attempt)
                    .ignoresSafeArea(edges: .bottom)
                if loading {
                    ProgressView()
                        .accessibilityLabel("Loading the guide")
                }
            }
        }
        .navigationTitle("Your first track day")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Link(destination: SettingsScreen.trackDaysGuideURL) {
                    Image(systemName: "safari")
                }
                .accessibilityLabel("Open in Safari")
            }
        }
    }
}

/// The rules the guide's web view follows, apart from WebKit so they can be
/// tested — Android's `GuidePage` carries the same three.
enum GuidePage {
    /// Appended to the web view's user agent; `site/analytics.js` reads it.
    static let userAgentMark = "TrackEvolution-App"

    /// The site chrome the screen's own bar replaces.
    static let hiddenChrome = ".site-header, .docs-sidebar, .docs-pager, .site-footer, .consent-banner"

    /// Installed at document start, before the first paint, so the site's
    /// header never flashes in and out. The page may have no `<html>` yet at
    /// that point, so it waits for one rather than assuming it — and adds its
    /// style once, however often it runs.
    static let chromeScript = """
        (function () {
          function add() {
            if (document.getElementById("te-app-frame")) return true;
            var root = document.head || document.documentElement;
            if (!root) return false;
            var s = document.createElement("style");
            s.id = "te-app-frame";
            s.textContent = "\(hiddenChrome) { display: none !important; } .docs-layout { padding-top: 20px; }";
            root.appendChild(s);
            return true;
          }
          if (!add()) new MutationObserver(function (_, o) { if (add()) o.disconnect(); })
            .observe(document, { childList: true, subtree: true });
        })();
        """

    /// Whether a link stays in the web view: the docs site's own pages do,
    /// anything else — an organizer, a store listing, a mail link — leaves.
    static func opensInApp(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host() else { return false }
        return host == docsHost
    }

    /// The host of `SettingsScreen.trackDaysGuideURL`, spelled out rather than
    /// read from a view's static so these rules stay free of the main actor.
    static let docsHost = "docs.trackevolution.app"
}

private struct GuideWebView: UIViewRepresentable {
    let url: URL
    @Binding var loading: Bool
    @Binding var failure: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = GuidePage.userAgentMark
        config.userContentController.addUserScript(
            WKUserScript(source: GuidePage.chromeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        // The page paints its own background; until it does, the screen's shows.
        view.isOpaque = false
        view.backgroundColor = .clear
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: GuideWebView

        init(_ parent: GuideWebView) {
            self.parent = parent
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if GuidePage.opensInApp(url) {
                // A docs link with a target of its own would otherwise go nowhere:
                // there is no second window here to open it in.
                if navigationAction.targetFrame == nil {
                    webView.load(navigationAction.request)
                    return .cancel
                }
                return .allow
            }
            _ = await UIApplication.shared.open(url)
            return .cancel
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.loading = true
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.loading = false
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            fail(error)
        }

        /// Only a failure to reach the page is news. A navigation this delegate
        /// cancelled — a link sent to the browser — reports itself as a failure
        /// too, and is not one.
        private func fail(_ error: Error) {
            parent.loading = false
            let error = error as NSError
            guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
            parent.failure = error.code == NSURLErrorNotConnectedToInternet
                ? "The guide is on the web, so it needs a connection. Try again once you have signal."
                : error.localizedDescription
        }
    }
}
