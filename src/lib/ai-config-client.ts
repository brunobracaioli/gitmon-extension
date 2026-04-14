/**
 * Thin client for the authenticated `/api/extension/ai-config` endpoint.
 *
 * Called from the service worker (never from content scripts — the
 * bearer token must stay in extension-scoped storage). Returns `null`
 * on any failure so callers can fall through to scripted phrases.
 */

import type { AIConfigSnapshot } from "@ext/lib/state-store";

const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

export async function fetchAIConfig(
  sessionToken: string,
): Promise<AIConfigSnapshot | null> {
  const url = `${WEB_ORIGIN}/api/extension/ai-config`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // 401 = bad token (caller should probably re-connect)
      // 404 = no active gitmon — normal for fresh/dead accounts
      return null;
    }
    const json = (await res.json().catch(() => null)) as AIConfigSnapshot | null;
    if (!json || typeof json !== "object" || !json.gitmon || !json.ai) {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}
