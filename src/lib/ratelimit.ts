// Rate limits for the MCP surface (#316, #317), on Workers' rate-limiting
// binding (`ratelimits` in wrangler.jsonc) rather than WAF rules: Claude and
// ChatGPT reach /mcp and /oauth/* from their own servers, so one IP stands for
// thousands of users and only the Worker knows which connection or client a
// request belongs to. The binding counts per Cloudflare location and is
// eventually consistent — an abuse guard, not exact accounting.
//
// A missing binding (a fork that didn't configure one) or a missing key
// means "not limited": the limits protect the service and must never be the
// reason a legitimate request fails.
export async function withinLimit(limiter: RateLimit | undefined, key: string | null | undefined): Promise<boolean> {
  if (!limiter || !key) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

// The binding's only windows are 10 s and 60 s; every limit here uses 60.
export const RATE_LIMIT_RETRY_AFTER_S = 60;
