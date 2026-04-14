/**
 * Allowlisted developer sites for Level 2 activity tracking (spec 10 §7.1).
 *
 * V1: github.com only. This requires ZERO new host_permissions (the
 * extension already has `https://github.com/*`), avoiding a CWS
 * re-review and a user-facing permission warning.
 *
 * V1.1+: expand to stackoverflow.com, dev.to, MDN, etc. Each new site
 * needs a host_permissions entry → CWS review + user re-consent.
 *
 * IMPORTANT: keep this list in sync with the server-side allowlist at
 * `src/lib/extension/tracked-sites.ts`. The server rejects events for
 * sites not in its allowlist (defense in depth).
 */

export const TRACKED_SITES = ["github.com"] as const;

export type TrackedSite = (typeof TRACKED_SITES)[number];

/** Returns true if the given hostname is in the allowlist. */
export function isTrackedSite(hostname: string): boolean {
  return TRACKED_SITES.includes(hostname as TrackedSite);
}
