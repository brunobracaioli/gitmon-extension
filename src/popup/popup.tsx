import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import {
  getStoredSession,
  openConnectFlow,
  clearSession,
  getLastConnectError,
  clearConnectError,
  type StoredSession,
} from "@ext/lib/auth-bridge";
import {
  getSettings,
  updateSettings,
  onSettingsChanged,
  type ExtensionSettings,
} from "@ext/lib/settings";

/**
 * GitMon extension popup.
 *
 * Auth flow architecture (M3):
 *   - Popup is ephemeral. When the user clicks Connect, we just open the
 *     connect tab. The popup will close as soon as the new tab gains
 *     focus (Chrome popup behavior — unavoidable).
 *   - The actual OTT exchange happens in the SERVICE WORKER, which
 *     receives the relayed message via chrome.runtime.onMessage.
 *   - When the user reopens this popup later, getStoredSession() in the
 *     mount effect picks up the session the SW saved. If the popup
 *     happens to still be open when storage changes (rare), the
 *     onChanged listener auto-transitions us live.
 */

type ViewState =
  | { kind: "loading" }
  | { kind: "disconnected"; lastError: string | null }
  | { kind: "waiting" }
  | { kind: "connected"; session: StoredSession }
  | { kind: "error"; message: string };

// Vite injects MODE at build time. We use it to differentiate the dev
// popup (orange G + "DEV" badge + localhost label) from the prod popup
// (purple G, no badge). Without this it's impossible to tell from a
// screenshot which extension's popup is open.
const IS_DEV_BUILD = import.meta.env.MODE === "development";

function Popup() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);

  // Load settings + subscribe to changes (Chrome Sync may push updates
  // from another machine while the popup is open).
  useEffect(() => {
    let cancelled = false;
    getSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });
    const unsub = onSettingsChanged((s) => setSettings(s));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleToggleEnabled = async () => {
    if (!settings) return;
    const next = await updateSettings({ enabled: !settings.enabled });
    setSettings(next);
  };

  // Bootstrap: read the stored session + any pending error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [session, lastError] = await Promise.all([
          getStoredSession(),
          getLastConnectError(),
        ]);
        if (cancelled) return;
        if (session) {
          setView({ kind: "connected", session });
        } else {
          setView({ kind: "disconnected", lastError });
        }
      } catch (err) {
        if (cancelled) return;
        setView({
          kind: "error",
          message: err instanceof Error ? err.message : "unknown error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live update: if storage changes while the popup is open (rare —
  // popup usually closes when the connect tab opens — but possible if
  // the user keeps the popup pinned via Chrome's "keep open" trick),
  // transition straight to the connected view.
  useEffect(() => {
    const onStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== "local") return;
      if (changes.gitmon_session_token || changes.gitmon_user) {
        getStoredSession().then((session) => {
          if (session) setView({ kind: "connected", session });
          else setView({ kind: "disconnected", lastError: null });
        });
      }
    };
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  const handleConnect = async () => {
    // Clear any previous error before starting fresh.
    await clearConnectError().catch(() => { /* ignore */ });
    setView({ kind: "waiting" });
    try {
      await openConnectFlow();
      // The popup will likely close now as the new tab takes focus.
      // The next time the user opens the popup, the bootstrap effect
      // above reads the session the service worker saved.
    } catch (err) {
      setView({
        kind: "error",
        message: err instanceof Error ? err.message : "open_failed",
      });
    }
  };

  const handleDisconnect = async () => {
    await clearSession();
    setView({ kind: "disconnected", lastError: null });
  };

  return (
    <div className={`gitmon-popup ${IS_DEV_BUILD ? "is-dev" : "is-prod"}`}>
      <header>
        <div className="logo">G</div>
        <div className="title">
          <strong>
            GitMon
            {IS_DEV_BUILD && <span className="dev-badge">DEV</span>}
          </strong>
          <span className="version">
            v0.1.0 {IS_DEV_BUILD && "· localhost:3000"}
          </span>
        </div>
      </header>

      <main>
        {view.kind === "loading" && (
          <p className="status">Loading…</p>
        )}

        {view.kind === "disconnected" && (
          <>
            <p className="status">Not connected yet.</p>
            <p className="hint">
              Connect your GitHub account to bring your GitMon into the
              browser. We&apos;ll open a tab for the secure handoff.
            </p>
            {view.lastError && (
              <p className="status status-err">
                Last attempt failed: {view.lastError}
              </p>
            )}
            <button className="btn btn-primary" onClick={handleConnect}>
              Connect to GitMon
            </button>
          </>
        )}

        {view.kind === "waiting" && (
          <>
            <p className="status">Tab opened — complete the handoff there.</p>
            <p className="hint">
              When you see &ldquo;✓ Connected&rdquo; on the page, this popup
              will catch up automatically. If it doesn&apos;t, just click
              the GitMon icon again.
            </p>
          </>
        )}

        {view.kind === "connected" && (
          <>
            <div className="user-card">
              {view.session.user.github_avatar_url && (
                <img
                  src={view.session.user.github_avatar_url}
                  alt={view.session.user.github_username ?? "user"}
                  width={40}
                  height={40}
                />
              )}
              <div>
                <strong>
                  @{view.session.user.github_username ?? "unknown"}
                </strong>
                <span className="meta">
                  Session valid until{" "}
                  {new Date(view.session.expires_at).toLocaleDateString()}
                </span>
              </div>
            </div>
            <p className="hint">
              Visit any GitHub page and your GitMon will be there.
            </p>

            {settings && (
              <div className="activity-badge">
                <span
                  className={`dot ${
                    settings.privacy_level >= 2 &&
                    settings.enable_activity_tracking
                      ? "on"
                      : "off"
                  }`}
                />
                Activity tracking:{" "}
                {settings.privacy_level >= 2 &&
                settings.enable_activity_tracking
                  ? "ON"
                  : "OFF"}
                {" · "}
                <a
                  href={chrome.runtime.getURL("src/options/index.html")}
                  target="_blank"
                  rel="noreferrer"
                >
                  Settings
                </a>
              </div>
            )}

            {settings && (
              <label className="toggle-row">
                <span className="toggle-label">
                  Show on GitHub
                  <span className="toggle-sub">
                    {settings.enabled
                      ? "Sprite injects on github.com tabs."
                      : "Hidden everywhere — flip on to bring it back."}
                  </span>
                </span>
                <span
                  className={`toggle-switch ${settings.enabled ? "on" : "off"}`}
                  role="switch"
                  aria-checked={settings.enabled}
                  tabIndex={0}
                  onClick={handleToggleEnabled}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      handleToggleEnabled();
                    }
                  }}
                >
                  <span className="toggle-knob" />
                </span>
              </label>
            )}

            <button className="btn btn-ghost" onClick={handleDisconnect}>
              Disconnect
            </button>
          </>
        )}

        {view.kind === "error" && (
          <>
            <p className="status status-err">Error: {view.message}</p>
            <button
              className="btn btn-ghost"
              onClick={() => setView({ kind: "disconnected", lastError: null })}
            >
              Try again
            </button>
          </>
        )}
      </main>

      <footer>
        <a href="https://gitmon.io" target="_blank" rel="noreferrer">
          gitmon.io
        </a>
        {" · "}
        <a href="https://gitmon.io/privacy" target="_blank" rel="noreferrer">
          Privacy
        </a>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
