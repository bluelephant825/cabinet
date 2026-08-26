"use client";
// Cloud-only analytics, GATED so open-source / self-hosted builds send us nothing.
// It initializes ONLY when NEXT_PUBLIC_POSTHOG_KEY is present, which is true solely in the cloud
// tenant image build (deploy sets the build arg). Without the key this is an inert no-op:
// posthog never inits, track() no-ops. distinct_id = the Supabase `sub` from the cabinet_jwt
// cookie, so a tenant's events stitch with the console funnel for the same user.
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";
import { subFromJwtCookie } from "@/lib/analytics/jwt-cookie";

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!KEY || typeof window === "undefined" || posthog.__loaded) return;
    posthog.init(KEY, {
      api_host: HOST,
      capture_pageview: true,
      capture_pageleave: true,
      person_profiles: "identified_only",
    });
    const sub = subFromJwtCookie(document.cookie);
    if (sub) posthog.identify(sub);
  }, []);
  return <PHProvider client={posthog}>{children}</PHProvider>;
}

/** Fire-and-forget capture that no-ops unless PostHog is configured (i.e. cloud builds only). */
export function track(event: string, props?: Record<string, unknown>) {
  if (KEY && typeof window !== "undefined" && posthog.__loaded) posthog.capture(event, props);
}
