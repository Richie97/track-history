import { cors } from "hono/cors";

// The native apps (mobile/) load the frontend from Capacitor's local WebView
// origins and call the API cross-origin with a Bearer token, so /api/* and
// /auth/* answer CORS for exactly these shell origins — nothing else. No
// credentials flag: auth is the Authorization header, never a cross-site
// cookie. Same-origin web requests are unaffected.
const APP_ORIGINS = new Set([
  "capacitor://localhost", // iOS Capacitor default
  "https://localhost", // Android Capacitor default
  "ionic://localhost", // legacy iOS scheme
  "http://localhost", // Android fallback (androidScheme: "http")
]);

export const appCors = cors({
  origin: (origin) => (APP_ORIGINS.has(origin) ? origin : null),
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
});
