# NS-08 — Authentication (iOS)

**Phase:** 0 · **Platform:** iOS · **Depends on:** NS-04 · **Estimate:** 3–4 days

## Goal

Sign in with Google and Apple, obtain a bearer token, store it securely, and hand
it to `APIClient`. **Zero backend changes** — the flow already exists and ships.

## The existing flow (do not modify the server)

`src/routes/auth.ts` already implements a full PKCE native-app flow, covered by
`test/api/native-auth.test.ts`:

1. App generates a PKCE verifier and its `S256` challenge (base64url).
2. App opens **in the system browser**
   `GET /auth/login?client=app&code_challenge=<challenge>`
   (or `/auth/apple/login?client=app&code_challenge=…`).
   Google forbids OAuth in embedded webviews — this must not be a `WKWebView`.
3. After the provider callback, the server mints a single-use code and redirects
   to `trackevolution://auth?code=<code>`.
4. App calls `POST /auth/exchange` with `{ code, code_verifier }` and receives
   `{ token }`.
5. That token goes in `Authorization: Bearer <token>` on every subsequent request
   (`src/middleware.ts` `requireSession` accepts it).

**Constraints that come from the server and must be honored:**
- The code TTL is **60 seconds** — do not stash it and exchange later.
- The code is **burned on first use, before verification**. A failed exchange
  cannot be retried with the same code; recover by restarting the whole flow.
- The challenge is `base64url(SHA-256(verifier))` with no padding. Getting the
  encoding wrong yields a `401 PKCE verification failed`.

## Requirements

1. **`ASWebAuthenticationSession`** with `callbackURLScheme: "trackevolution"`.
   Set `prefersEphemeralWebBrowserSession = false` so an existing Google session
   in Safari is reused — that is the difference between a two-tap sign-in and
   retyping a password.
2. **PKCE** — cryptographically random verifier (43–128 chars, unreserved set),
   `S256` challenge. Hold the verifier in memory for the flow; it never needs to
   outlive it.
3. **Token storage in the Keychain**, `kSecAttrAccessibleAfterFirstUnlock`.
   Not `WhenUnlocked`: **the lap recorder runs with the phone locked and must be
   able to sync**, and not `...ThisDeviceOnly` unless you deliberately want to
   block iCloud Keychain restore — decide and document which.
4. **Implement the `TokenProviding` protocol** defined in NS-04. `APIClient` stays
   ignorant of the Keychain.
5. **Provider buttons gated by `GET /auth/providers`**, which returns
   `{ google: bool, apple: bool }` — Apple is only enabled when that server carries
   the `APPLE_*` secrets. Do not hardcode the Apple button as visible.
   - Use the real **"Sign in with Apple" button styling**; App Review rejects
     approximations. Note this flow goes through the web endpoint
     (`/auth/apple/login`), *not* `ASAuthorizationAppleIDProvider` — the server
     owns the token exchange. Confirm during review prep that this satisfies the
     guideline; if it does not, raise it rather than changing the server.
6. **401 handling.** A `401` from any request means the session is gone (expired
   or revoked). Clear the token, drop to the sign-in screen, and do **not**
   silently retry.
7. **Sign-out** — `POST /auth/logout` with the bearer token, then clear the
   Keychain entry **and all cached data** (NS-21's store). A shared device must not
   retain the previous user's logbook; the web app already does this deliberately.
8. **Deep links.** Universal Links for `https://trackevolution.app/share/*` should
   open the app. Cold start must work: capture the launch URL before the UI is
   ready and route once it is. `src/routes/wellKnown.ts` already serves the
   apple-app-site-association — no server change needed.
9. **Dev server override.** Keep an equivalent of the Capacitor shell's
   server-settings panel so the app can point at `wrangler dev`. Note the server's
   `DEV_MODE` bypass only answers on `localhost`, `127.0.0.1`, `[::1]`, and
   `10.0.2.2` — a real device on the LAN will not hit it and needs real OAuth.

## Acceptance criteria

- [ ] Google sign-in completes end to end on a device and returns a working token.
- [ ] Apple sign-in completes when the server advertises it, and the button is hidden when it does not.
- [ ] Token survives app restart and is readable while the device is locked.
- [ ] An expired/invalid code produces a clear error and a clean retry, not a stuck screen.
- [ ] `GET /api/me` succeeds immediately after sign-in.
- [ ] Signing in with Google and then Apple on the same email lands on **one** account (the server links by verified email).
- [ ] Sign-out clears both token and cached data; relaunch shows the sign-in screen.
- [ ] A `/share/<slug>` Universal Link opens the app from cold start.
- [ ] `git diff --stat src/` is empty — **if you changed the server, the spec was misread.**

## Verification

```sh
npm run dev            # wrangler dev on :8787
```
Point the app at `http://localhost:8787` in the simulator and exercise the
`DEV_MODE` bypass, then test real OAuth against production. `test/api/native-auth.test.ts`
documents the expected server responses for each failure mode.

## Notes

- Sign-in must **not** happen in an embedded webview. This is a hard Google
  requirement and the reason the flow is shaped this way.
- Both callbacks reject id_tokens whose email is unverified, because accounts are
  claimed by email. Nothing to do client-side — just don't be surprised by a
  rejection with an unverified test account.
