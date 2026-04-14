import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./options.css";
import {
  getSettings,
  updateSettings,
  onSettingsChanged,
  type ExtensionSettings,
} from "@ext/lib/settings";
import { getStoredSession, type StoredSession } from "@ext/lib/auth-bridge";
import { peekQueue } from "@ext/lib/activity-client";
import { TRACKED_SITES } from "@ext/lib/tracked-sites";

const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

/**
 * GitMon extension options page — privacy level selector, activity
 * tracking consent, and flush audit log (spec 10 §6.1, §7).
 */

function Options() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [level2Available, setLevel2Available] = useState<boolean | null>(null);
  const [queueSize, setQueueSize] = useState(0);

  // Load settings + session
  useEffect(() => {
    getSettings().then(setSettings);
    getStoredSession().then(setSession);
    peekQueue().then((q) => setQueueSize(q.length));
    const unsub = onSettingsChanged(setSettings);
    return unsub;
  }, []);

  // Check server-side feature flag
  useEffect(() => {
    fetch(`${WEB_ORIGIN}/api/v1/extension/features`)
      .then((res) => res.json())
      .then((data: { level2_available: boolean }) => {
        setLevel2Available(data.level2_available);
      })
      .catch(() => setLevel2Available(false));
  }, []);

  const handlePrivacyLevel = async (level: 1 | 2) => {
    if (!settings) return;
    const next = await updateSettings({
      privacy_level: level,
      // Auto-enable tracking when upgrading to Level 2, disable when downgrading
      enable_activity_tracking: level >= 2,
    });
    setSettings(next);
  };

  const handleFlush = () => {
    chrome.runtime.sendMessage({ type: "gitmon:activity:flush" }, () => {
      peekQueue().then((q) => setQueueSize(q.length));
    });
  };

  const isLevel2Enabled = level2Available === true;
  const isTracking =
    settings?.privacy_level !== undefined &&
    settings.privacy_level >= 2 &&
    settings.enable_activity_tracking;

  return (
    <div className="options-page">
      <header>
        <div className="logo">G</div>
        <div>
          <h1>GitMon Settings</h1>
          <p className="subtitle">
            {session
              ? `Connected as @${session.user.github_username ?? "unknown"}`
              : "Not connected"}
          </p>
        </div>
      </header>

      <main>
        {!session && (
          <section>
            <h2>Connect first</h2>
            <p>
              Open the GitMon popup on any GitHub page and click
              &ldquo;Connect&rdquo; to link your account before changing
              settings.
            </p>
          </section>
        )}

        {session && (
          <>
            <section>
              <h2>Privacy Level</h2>
              <p className="description">
                Choose what the extension collects. You can change this at any
                time.
              </p>

              <label className="radio-card">
                <input
                  type="radio"
                  name="privacy_level"
                  checked={settings?.privacy_level === 1}
                  onChange={() => handlePrivacyLevel(1)}
                />
                <div>
                  <strong>Level 1 — Minimal (default)</strong>
                  <p>
                    Auth token and settings only. No activity data leaves your
                    browser.
                  </p>
                </div>
              </label>

              <label
                className={`radio-card ${!isLevel2Enabled ? "disabled" : ""}`}
              >
                <input
                  type="radio"
                  name="privacy_level"
                  checked={
                    settings?.privacy_level !== undefined &&
                    settings.privacy_level >= 2
                  }
                  onChange={() => handlePrivacyLevel(2)}
                  disabled={!isLevel2Enabled}
                />
                <div>
                  <strong>Level 2 — Activity tracking</strong>
                  {isLevel2Enabled ? (
                    <p>
                      Track time spent on developer sites to feed your GitMon.
                      Data is sent to GitMon servers and aggregated with your
                      profile.
                    </p>
                  ) : (
                    <p className="coming-soon">
                      Coming soon — this feature is not yet available.
                    </p>
                  )}
                </div>
              </label>
            </section>

            {isTracking && (
              <section>
                <h2>Tracked Sites</h2>
                <p className="description">
                  Time is counted only when the tab is visible, the browser is
                  focused, and you are not idle for more than 5 minutes.
                </p>
                <ul className="site-list">
                  {TRACKED_SITES.map((site) => (
                    <li key={site}>
                      <code>{site}</code>
                    </li>
                  ))}
                </ul>
                <p className="fine-print">
                  We never read page content, form values, or search queries.
                  Only time-on-site per domain is recorded.
                </p>
              </section>
            )}

            {isTracking && (
              <section>
                <h2>Data Queue</h2>
                <p className="description">
                  {queueSize === 0
                    ? "No pending events — all data has been sent."
                    : `${queueSize} event(s) waiting to be sent.`}
                </p>
                <button className="btn btn-secondary" onClick={handleFlush}>
                  Flush now
                </button>
              </section>
            )}

            <section>
              <h2>Consent</h2>
              <p className="fine-print">
                By enabling Level 2, you agree that time-on-site data will be
                sent to GitMon servers and aggregated with your profile. You
                can disable this at any time and request deletion from{" "}
                <a
                  href={`${WEB_ORIGIN}/privacy`}
                  target="_blank"
                  rel="noreferrer"
                >
                  our Privacy Policy
                </a>
                .
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Options />
    </StrictMode>,
  );
}
