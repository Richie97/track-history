# NS-09 — Authentication (Android)

**Phase:** 0 · **Platform:** Android · **Depends on:** NS-05 · **Estimate:** 3–4 days

## Goal

Sign in with Google and Apple, obtain a bearer token, store it securely, hand it
to `ApiClient`. **Zero backend changes.**

**Read `NS-08-ios-auth.md` first** — it documents the existing server flow, its
60-second single-use code, the PKCE encoding, and the account-linking behavior.
That material is not repeated here.

## Requirements

1. **Chrome Custom Tabs** for the authorization step — *not* a `WebView`. Google
   forbids OAuth in embedded webviews, and a `WebView` here will be blocked.
   Fall back to the default browser via `ACTION_VIEW` if no Custom Tabs provider
   exists.
2. **Callback via intent filter** on `trackevolution://auth`, declared in NS-02.
   Use `launchMode="singleTask"` + `onNewIntent` so returning from the browser
   resumes the existing task rather than stacking a second activity.
3. **PKCE** — random verifier, `S256` challenge, `base64url` **without padding**
   (`Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP` — the default
   `Base64.encodeToString` appends a newline and will fail verification).
   The verifier must survive process death during the browser hop: persist it,
   don't hold it only in an in-memory ViewModel.
4. **Token storage** in `EncryptedSharedPreferences` (or DataStore + Jetpack
   Security). Must be readable while the device is locked — **the lap recorder
   runs locked and needs to sync.**
5. **Implement the `TokenProvider` interface** from NS-05. `:core` stays free of
   Android keystore APIs.
6. **Provider buttons gated by `GET /auth/providers`** (`{ google, apple }`). Apple
   is only enabled when the server carries the `APPLE_*` secrets — do not hardcode
   it visible. Apple sign-in on Android goes through the same web endpoint
   (`/auth/apple/login?client=app&…`); there is no native Apple SDK involved.
7. **401 handling** — clear the token, return to sign-in, no silent retry.
8. **Sign-out** — `POST /auth/logout` with the bearer token, then clear the token
   **and all cached data** (NS-22's store). A shared device must not retain the
   previous user's logbook.
9. **App Links** for `https://trackevolution.app/share/*` with `autoVerify="true"`;
   `public/.well-known/assetlinks.json` already exists — **verify the SHA-256
   signing-certificate fingerprint in it matches the key this app is signed with.**
   If it does not, that is a real blocker to raise, not something to patch around.
   Cold-start deep links must route correctly.
10. **Dev server override.** The server's `DEV_MODE` bypass answers on `10.0.2.2`
    — the emulator's alias for the host — so an emulator pointed at
    `http://10.0.2.2:8787` gets one-tap local sign-in. Note this requires a
    cleartext-traffic exception scoped to debug builds only; never ship it in
    release.

## Acceptance criteria

- [ ] Google sign-in completes on a device and returns a working token.
- [ ] Apple sign-in completes when advertised; button hidden when not.
- [ ] Token survives app restart, process death, and device lock.
- [ ] The PKCE verifier survives process death during the browser hop.
- [ ] Expired/invalid code gives a clear error and a clean retry.
- [ ] `GET /api/me` succeeds immediately after sign-in.
- [ ] Google then Apple on the same email lands on **one** account.
- [ ] Sign-out clears token and cached data.
- [ ] A `/share/<slug>` App Link opens the app from cold start.
- [ ] Release build has no cleartext-traffic permission.
- [ ] `git diff --stat src/` is empty.

## Verification

```sh
npm run dev    # wrangler dev on :8787
```
Point an emulator build at `http://10.0.2.2:8787` for the `DEV_MODE` bypass, then
test real OAuth against production on a physical device.
`test/api/native-auth.test.ts` documents the expected server responses.

## Notes

- Verify App Links with
  `adb shell pm get-app-links app.trackevolution` — it must report `verified`.
- No embedded webview. This is a hard Google requirement.
