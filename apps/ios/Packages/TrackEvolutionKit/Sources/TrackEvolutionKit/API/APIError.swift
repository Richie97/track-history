import Foundation

/// Everything that can go wrong talking to the API. Mirrors `ApiError` in
/// `public/js/api.js`: the server sends `{ "error": string }` with a meaningful
/// status, and **that string is what the UI shows** — never replace it with a
/// generic message of our own.
public enum APIError: Error, Hashable, Sendable {
    /// 401. Distinct so the app can drop straight to re-auth.
    case unauthorized(String)
    /// Any other non-2xx, carrying the server's status and message.
    case server(status: Int, message: String)
    /// No answer at all — offline, DNS, timeout. Not the server's fault, and
    /// (unlike the cases above) worth retrying.
    case transport(String)
    /// A 2xx body that didn't match its model: contract drift, or a bug here.
    case decoding(String)

    public var status: Int? {
        switch self {
        case .unauthorized: 401
        case .server(let status, _): status
        case .transport, .decoding: nil
        }
    }

    /// The message to show the user.
    public var message: String {
        switch self {
        case .unauthorized(let message),
             .server(_, let message),
             .transport(let message),
             .decoding(let message):
            message
        }
    }

    public var isUnauthorized: Bool {
        if case .unauthorized = self { return true }
        return false
    }

    /// Map a non-2xx response to an error, preferring the server's own message
    /// and falling back to `Request failed (<status>)` exactly like the web
    /// client does when the body isn't the expected shape.
    public static func from(status: Int, body: Data) -> APIError {
        let message = (try? JSONDecoder().decode(ServerErrorBody.self, from: body))?.error
            ?? "Request failed (\(status))"
        return status == 401 ? .unauthorized(message) : .server(status: status, message: message)
    }
}

/// The error body every failing endpoint returns.
public struct ServerErrorBody: Codable, Hashable, Sendable {
    public var error: String
}

extension APIError: LocalizedError {
    public var errorDescription: String? { message }
}
