/**
 * GitMon extension — auth bridge (shared between popup + service worker).
 *
 * Architecture:
 *   - Popup is ephemeral (closes when it loses focus, i.e. as soon as
 *     chrome.tabs.create() opens a new tab). Cannot host the
 *     chrome.runtime.onMessage listener that receives the OTT relay.
 *   - Service worker is persistent enough — wakes up automatically when
 *     chrome.runtime.onMessage fires. THAT is where the listener lives,
 *     in `service-worker.ts`.
 *   - This file exposes pure helpers used by BOTH contexts:
 *       - getStoredSession / storeSession / clearSession (state)
 *       - exchangeOttForSession (network call to /api/extension/exchange)
 *       - openConnectFlow (popup-only — opens the connect page in a tab)
 *
 * Flow recap:
 *   1. User clicks Connect in the popup
 *   2. Popup calls `openConnectFlow()` → chrome.tabs.create
 *   3. Popup CLOSES (Chrome popup UX — unavoidable)
 *   4. /extension/connect page generates OTT, postMessages to its
 *      content script
 *   5. Content script forwards via chrome.runtime.sendMessage
 *   6. SERVICE WORKER receives the message, calls exchangeOttForSession,
 *      calls storeSession
 *   7. User reopens the popup → getStoredSession finds the row → shows
 *      "Connected as @username". Storage onChanged also fires if the
 *      popup happens to still be open.
 */

const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

const STORAGE_TOKEN_KEY = "gitmon_session_token";
const STORAGE_USER_KEY = "gitmon_user";
const STORAGE_LAST_ERROR_KEY = "gitmon_last_connect_error";

export interface ExtensionUser {
  id: string;
  github_username: string | null;
  github_avatar_url: string | null;
}

export interface StoredSession {
  token: string;
  expires_at: string;
  user: ExtensionUser;
}

/** Read the current stored session, if any. */
export async function getStoredSession(): Promise<StoredSession | null> {
  const result = await chrome.storage.local.get([STORAGE_TOKEN_KEY, STORAGE_USER_KEY]);
  const token = result[STORAGE_TOKEN_KEY] as
    | { token: string; expires_at: string }
    | undefined;
  const user = result[STORAGE_USER_KEY] as ExtensionUser | undefined;
  if (!token || !user) return null;
  // Expiry check — return null instead of throwing so callers can
  // gracefully prompt for re-connect.
  if (new Date(token.expires_at).getTime() < Date.now()) return null;
  return { token: token.token, expires_at: token.expires_at, user };
}

/** Persist a fresh session. Used by the service worker after exchange. */
export async function storeSession(session: StoredSession): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_TOKEN_KEY]: { token: session.token, expires_at: session.expires_at },
    [STORAGE_USER_KEY]: session.user,
  });
  // Clear any previous error.
  await chrome.storage.local.remove(STORAGE_LAST_ERROR_KEY);
}

/** Clear the session (used by the "Disconnect" button in M5 settings). */
export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_TOKEN_KEY, STORAGE_USER_KEY, STORAGE_LAST_ERROR_KEY]);
}

/** Read the last connect error, if any. The service worker writes this on
 *  exchange failure so the popup can surface it on reopen. */
export async function getLastConnectError(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_LAST_ERROR_KEY);
  return (result[STORAGE_LAST_ERROR_KEY] as string | null) ?? null;
}

/** Persist a connect error so the popup can show it on reopen. */
export async function storeConnectError(message: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_LAST_ERROR_KEY]: message });
}

/** Clear any stored error. */
export async function clearConnectError(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_LAST_ERROR_KEY);
}

/**
 * Exchange a one-time token for a long-lived session by calling
 * POST /api/extension/exchange. Pure function, no chrome.* dependencies
 * — caller stores the result via storeSession().
 *
 * Throws on HTTP error so the caller can write storeConnectError.
 */
export async function exchangeOttForSession(ott: string): Promise<StoredSession> {
  const res = await fetch(`${WEB_ORIGIN}/api/extension/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ott }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`exchange_failed: ${res.status} ${text}`);
  }
  return (await res.json()) as StoredSession;
}

/**
 * Popup-only: open the connect page in a new tab. Does NOT await the
 * handoff — that's the service worker's job. The popup will close as
 * soon as the new tab gains focus, which is fine: when the user reopens
 * the popup, getStoredSession() picks up the session the SW saved.
 */
export async function openConnectFlow(): Promise<void> {
  await chrome.tabs.create({
    url: `${WEB_ORIGIN}/extension/connect`,
    active: true,
  });
}
