/**
 * GitMon extension — background service worker (Manifest V3).
 *
 * Responsibilities:
 *
 * 1. **Auth bridge (M3).** Hosts the chrome.runtime.onMessage listener
 *    that receives the OTT relay from `auth-bridge-content.ts` (which
 *    runs on `/extension/connect`). The popup CANNOT host this listener
 *    because Chrome closes the popup as soon as chrome.tabs.create()
 *    opens a new tab, killing the listener mid-flight. The SW wakes
 *    automatically on chrome.runtime.onMessage and stays alive long
 *    enough to do the exchange.
 *
 * 2. **State pull (M4).** A chrome.alarms-driven 60s loop fetches
 *    `${WEB_ORIGIN}/api/v1/public/gitmon/{username}` using the stored
 *    session's GitHub username, persists the response in
 *    chrome.storage.local, and broadcasts the snapshot to every open
 *    github.com tab via chrome.tabs.sendMessage. Content scripts also
 *    pull-on-mount via `gitmon:state:get` so a freshly opened tab
 *    doesn't have to wait up to 60s.
 *
 * Why a SW alarm and not a content-script setInterval: a single SW alarm
 * = a single fetch per 60s regardless of how many GitHub tabs are open.
 * Doing it per-content-script would N× the API load.
 *
 * Future:
 *  - M5: respond to click events from the content script with mini-popup
 *    payloads.
 *  - V1: GitHub notifications via chrome.notifications.
 *  - V1: §4.4 autonomous AI commentary trigger evaluation.
 */

import {
  exchangeOttForSession,
  getStoredSession,
  storeSession,
  storeConnectError,
} from "@ext/lib/auth-bridge";
import {
  storeState,
  getStoredState,
  clearStoredState,
  storeAIConfig,
  getStoredAIConfig,
  clearStoredAIConfig,
  type GitMonStateSnapshot,
  type AIConfigSnapshot,
} from "@ext/lib/state-store";
import { fetchAIConfig } from "@ext/lib/ai-config-client";
import { onActivityTick, flushBatch } from "@ext/background/activity-tracker";

const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (...args: any[]) => console.log("[gitmon sw]", ...args);

/** Alarm names — namespaced so we can add more alarms later without collision. */
const ALARM_STATE_PULL = "gitmon:state-pull";
const STATE_PULL_PERIOD_MIN = 1; // chrome.alarms minimum is 1 minute in prod (30s in dev)
const ALARM_AI_CONFIG_PULL = "gitmon:ai-config-pull";
const AI_CONFIG_PULL_PERIOD_MIN = 6 * 60; // 6h — AI config rarely changes
const ALARM_ACTIVITY_HEARTBEAT = "gitmon:activity-heartbeat";
const ACTIVITY_HEARTBEAT_PERIOD_MIN = 1; // 1 minute heartbeat, flush every 5

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener((details) => {
  log("installed", details.reason);
  scheduleStatePullAlarm();
  scheduleAIConfigPullAlarm();
  scheduleActivityHeartbeatAlarm();
  // Best-effort immediate pull so freshly installed users see something.
  pullState().catch((err) => log("install-time pull failed:", err.message));
  pullAIConfig().catch((err) => log("install-time ai pull failed:", err.message));
});

chrome.runtime.onStartup.addListener(() => {
  log("startup");
  scheduleStatePullAlarm();
  scheduleAIConfigPullAlarm();
  scheduleActivityHeartbeatAlarm();
  pullState().catch((err) => log("startup pull failed:", err.message));
  pullAIConfig().catch((err) => log("startup ai pull failed:", err.message));
});

function scheduleStatePullAlarm(): void {
  chrome.alarms.get(ALARM_STATE_PULL, (existing) => {
    if (existing) {
      log("state alarm already scheduled");
      return;
    }
    chrome.alarms.create(ALARM_STATE_PULL, {
      periodInMinutes: STATE_PULL_PERIOD_MIN,
    });
    log("state alarm scheduled every", STATE_PULL_PERIOD_MIN, "min");
  });
}

function scheduleAIConfigPullAlarm(): void {
  chrome.alarms.get(ALARM_AI_CONFIG_PULL, (existing) => {
    if (existing) {
      log("ai-config alarm already scheduled");
      return;
    }
    chrome.alarms.create(ALARM_AI_CONFIG_PULL, {
      periodInMinutes: AI_CONFIG_PULL_PERIOD_MIN,
    });
    log("ai-config alarm scheduled every", AI_CONFIG_PULL_PERIOD_MIN, "min");
  });
}

function scheduleActivityHeartbeatAlarm(): void {
  chrome.alarms.get(ALARM_ACTIVITY_HEARTBEAT, (existing) => {
    if (existing) {
      log("activity heartbeat alarm already scheduled");
      return;
    }
    chrome.alarms.create(ALARM_ACTIVITY_HEARTBEAT, {
      periodInMinutes: ACTIVITY_HEARTBEAT_PERIOD_MIN,
    });
    log("activity heartbeat alarm scheduled every", ACTIVITY_HEARTBEAT_PERIOD_MIN, "min");
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_STATE_PULL) {
    pullState().catch((err) => log("alarm pull failed:", err.message));
  } else if (alarm.name === ALARM_AI_CONFIG_PULL) {
    pullAIConfig().catch((err) => log("alarm ai pull failed:", err.message));
  } else if (alarm.name === ALARM_ACTIVITY_HEARTBEAT) {
    onActivityTick().catch((err) =>
      log("activity tick failed:", err.message),
    );
  }
});

/**
 * Watch chrome.storage.local for session changes. When the user connects
 * (M3 exchange writes the session), trigger an immediate pull instead of
 * waiting up to 60s for the next alarm. When they disconnect, clear the
 * cached state so content scripts re-render to the placeholder.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!("gitmon_session_token" in changes)) return;

  const next = changes.gitmon_session_token.newValue;
  if (next) {
    log("session created — triggering immediate pulls");
    pullState().catch((err) => log("post-connect pull failed:", err.message));
    pullAIConfig().catch((err) =>
      log("post-connect ai pull failed:", err.message),
    );
  } else {
    log("session cleared — clearing cached state + ai config");
    Promise.all([clearStoredState(), clearStoredAIConfig()])
      .then(() => {
        broadcastStateToTabs(null).catch(() => { /* ignore */ });
        broadcastAIConfigToTabs(null).catch(() => { /* ignore */ });
      })
      .catch(() => { /* ignore */ });
  }
});

/* -------------------------------------------------------------------------- */
/*  Message router                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Top-level message router. Handles BOTH the M3 OTT relay and M4 state
 * requests from content scripts.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log("message", msg?.type, "from tab", sender.tab?.id);

  if (msg?.type === "gitmon:extension:handoff" && typeof msg.ott === "string") {
    handleHandoff(msg.ott)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => {
        log("handoff failed:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async sendResponse
  }

  if (msg?.type === "gitmon:state:get") {
    handleStateGet()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err: Error) => {
        log("state:get failed:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async sendResponse
  }

  if (msg?.type === "gitmon:ai-config:get") {
    handleAIConfigGet()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((err: Error) => {
        log("ai-config:get failed:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async sendResponse
  }

  if (msg?.type === "gitmon:activity:flush") {
    flushBatch()
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => {
        log("activity:flush failed:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async sendResponse
  }

  sendResponse({ ok: false, error: "unknown_message_type" });
  return false;
});

/* -------------------------------------------------------------------------- */
/*  Auth (M3)                                                                  */
/* -------------------------------------------------------------------------- */

async function handleHandoff(ott: string): Promise<void> {
  try {
    log("exchanging OTT", ott.slice(0, 8) + "...");
    const session = await exchangeOttForSession(ott);
    await storeSession(session);
    log("session stored for", session.user.github_username ?? session.user.id);

    // Close the connect tab on success.
    if (WEB_ORIGIN) {
      const tabs = await chrome.tabs
        .query({ url: `${WEB_ORIGIN}/extension/connect*` })
        .catch(() => [] as chrome.tabs.Tab[]);
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.remove(tab.id).catch(() => { /* ignore */ });
        }
      }
    }
    // The storage.onChanged listener will pick up the new session and
    // trigger pullState() — no need to call it explicitly here.
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    await storeConnectError(message).catch(() => { /* ignore */ });
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  State pull (M4)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Returns the cached state if present. If the cache is empty but a
 * session exists, fires a fresh pull and returns its result. This makes
 * a content script's first `gitmon:state:get` after install reliable
 * even if the alarm hasn't fired yet.
 */
async function handleStateGet(): Promise<GitMonStateSnapshot | null> {
  const cached = await getStoredState();
  if (cached) return cached;

  const session = await getStoredSession();
  if (!session?.user?.github_username) return null;

  return await pullState();
}

/**
 * Fetch the current GitMon state from the public API and persist it.
 * Returns the new state snapshot, or null if there's no session / no
 * github username (the renderer treats null as "show placeholder").
 *
 * Errors are logged and swallowed — a transient API failure should not
 * crash the SW. The next alarm tick will retry. We do NOT clear the
 * cached state on failure: stale data is better than no data here.
 */
async function pullState(): Promise<GitMonStateSnapshot | null> {
  const session = await getStoredSession();
  if (!session) {
    log("pull: no session");
    return null;
  }
  const username = session.user.github_username;
  if (!username) {
    log("pull: session has no github_username");
    return null;
  }

  const url = `${WEB_ORIGIN}/api/v1/public/gitmon/${encodeURIComponent(username)}`;
  log("pull:", url);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      // Force a network read every minute — the public endpoint already
      // sets s-maxage=300, but we want fresher data than that for the
      // companion. Browser HTTP cache is bypassed via cache: 'no-store'.
      cache: "no-store",
    });
  } catch (err) {
    log("pull network error:", (err as Error).message);
    return null;
  }

  if (!res.ok) {
    log("pull http error:", res.status);
    return null;
  }

  const json = (await res.json().catch(() => null)) as GitMonStateSnapshot | null;
  if (!json || typeof json !== "object" || !json.species_id) {
    log("pull: malformed response");
    return null;
  }

  await storeState(json);
  log("pull: stored", json.species_id, "stage", json.evolution_stage, "status", json.status);

  // Broadcast to any open GitHub tabs so they re-render immediately.
  broadcastStateToTabs(json).catch(() => { /* per-tab errors are non-fatal */ });

  return json;
}

/**
 * Push the latest state (or null on disconnect) to every open github.com
 * tab. We rely on host_permissions: ["https://github.com/*"] — no `tabs`
 * permission needed for the URL filter to match.
 *
 * Errors per-tab are expected and ignored: a tab might have just closed
 * or might not have the content script loaded yet (Chrome injects on
 * navigation, not on every focus). The next alarm tick will retry.
 */
async function broadcastStateToTabs(
  state: GitMonStateSnapshot | null,
): Promise<void> {
  const tabs = await chrome.tabs
    .query({ url: "https://github.com/*" })
    .catch(() => [] as chrome.tabs.Tab[]);

  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs
      .sendMessage(tab.id, { type: "gitmon:state:update", state })
      .catch(() => { /* tab closed or no listener — ignore */ });
  }
}

/* -------------------------------------------------------------------------- */
/*  AI config pull                                                             */
/* -------------------------------------------------------------------------- */

async function handleAIConfigGet(): Promise<AIConfigSnapshot | null> {
  const cached = await getStoredAIConfig();
  if (cached) return cached;
  const session = await getStoredSession();
  if (!session?.token) return null;
  return await pullAIConfig();
}

/**
 * Pull the AI personality + key + minimal gitmon context via the
 * authenticated extension endpoint. Cached so the speech-bubble
 * scheduler can read it synchronously from chrome.storage.local.
 *
 * Failures are silent: next alarm tick retries. Stale cache is
 * preserved because an empty cache would force every tick onto the
 * fallback pool unnecessarily.
 */
async function pullAIConfig(): Promise<AIConfigSnapshot | null> {
  const session = await getStoredSession();
  if (!session?.token) {
    log("ai pull: no session");
    return null;
  }

  const config = await fetchAIConfig(session.token);
  if (!config) {
    log("ai pull: fetch failed or no active gitmon");
    return null;
  }

  await storeAIConfig(config);
  log(
    "ai pull: stored",
    config.gitmon.species_name,
    "provider",
    config.ai.provider ?? "none",
  );
  broadcastAIConfigToTabs(config).catch(() => { /* ignore */ });
  return config;
}

async function broadcastAIConfigToTabs(
  config: AIConfigSnapshot | null,
): Promise<void> {
  const tabs = await chrome.tabs
    .query({ url: "https://github.com/*" })
    .catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs
      .sendMessage(tab.id, { type: "gitmon:ai-config:update", config })
      .catch(() => { /* ignore */ });
  }
}

log("loaded");
export {};
