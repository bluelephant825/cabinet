// The console (app.runcabinet.com) sets a non-httpOnly `cabinet_jwt` cookie scoped to
// Domain=.runcabinet.com, so it is also readable at {slug}.runcabinet.com. We pull the Supabase
// `sub` out of it to use as the PostHog distinct_id, so a tenant's events stitch with the
// console's funnel for the same user. We do NOT verify the signature: this is only a distinct_id
// label, and the host-agent already gate-verifies the real request before it ever reaches here.
export function subFromJwtCookie(cookie: string): string | null {
  const m = /(?:^|;\s*)cabinet_jwt=([^;]+)/.exec(cookie);
  if (!m) return null;
  try {
    const payload = m[1].split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return (JSON.parse(json).sub as string) ?? null;
  } catch {
    return null;
  }
}
