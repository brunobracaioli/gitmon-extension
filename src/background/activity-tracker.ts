/**
 * Extension Level 2 — Activity tracker (spec 10 §7).
 *
 * Architecture: a 1-minute heartbeat checks whether the active tab is on
 * a tracked site, the browser is focused, and the user is not idle. If
 * all conditions are met, it increments an in-memory counter for that
 * site. Every 5 ticks (5 minutes), the accumulated batch is flushed to
 * chrome.storage.local and then to the server.
 *
 * All logic lives in the service worker (invariant: spec 10 rule #15).
 * No content script involvement for time tracking.
 *
 * The tracker is a no-op when `privacy_level < 2` or
 * `enable_activity_tracking === false`.
 */

import { getSettings } from "@ext/lib/settings";
import { isTrackedSite } from "@ext/lib/tracked-sites";
import { enqueueEvents, flushActivityBatch, type ActivityEvent } from "@ext/lib/activity-client";

/** In-memory accumulator: site hostname → minutes this batch. */
const batch = new Map<string, number>();

/** Tick counter. Flush every FLUSH_INTERVAL ticks. */
let tickCount = 0;
const FLUSH_INTERVAL = 5; // flush every 5 minutes

/** Idle threshold in seconds (spec 10 §7.2: idle > 5 min = skip). */
const IDLE_THRESHOLD_SEC = 300;

/**
 * Called every 60 seconds by the service-worker alarm handler.
 * Returns true if a minute was tracked, false if skipped.
 */
export async function onActivityTick(): Promise<boolean> {
  // 1. Check settings
  const settings = await getSettings();
  if (settings.privacy_level < 2 || !settings.enable_activity_tracking) {
    return false;
  }

  // 2. Check idle state
  const idleState = await chrome.idle.queryState(IDLE_THRESHOLD_SEC);
  if (idleState !== "active") {
    return false;
  }

  // 3. Check if browser window is focused
  let focused = false;
  try {
    const win = await chrome.windows.getLastFocused();
    focused = win.focused ?? false;
  } catch {
    // No window open
    return false;
  }
  if (!focused) return false;

  // 4. Get the active tab URL
  let hostname: string | null = null;
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs[0]?.url) {
      hostname = new URL(tabs[0].url).hostname;
    }
  } catch {
    return false;
  }

  if (!hostname || !isTrackedSite(hostname)) {
    return false;
  }

  // 5. Increment the batch counter for this site
  batch.set(hostname, (batch.get(hostname) ?? 0) + 1);
  tickCount++;

  // 6. Flush every FLUSH_INTERVAL ticks
  if (tickCount >= FLUSH_INTERVAL) {
    await flushBatch();
    tickCount = 0;
  }

  return true;
}

/**
 * Flush the in-memory batch to chrome.storage.local queue, then attempt
 * to send to server. Called automatically every 5 ticks, and can also be
 * called manually (e.g., on browser shutdown or from options page).
 */
export async function flushBatch(): Promise<void> {
  if (batch.size === 0) return;

  const now = new Date().toISOString();
  const events: ActivityEvent[] = [];

  for (const [site, minutes] of batch) {
    if (minutes > 0) {
      events.push({ site, minutes, ts: now });
    }
  }

  batch.clear();

  if (events.length === 0) return;

  // Enqueue in storage (survives SW restarts)
  await enqueueEvents(events);

  // Attempt immediate server flush
  try {
    const result = await chrome.storage.local.get("gitmon_session_token");
    const token = result.gitmon_session_token as string | undefined;
    if (token) {
      await flushActivityBatch(token);
    }
  } catch (err) {
    // Will retry on next flush cycle
    console.warn("[gitmon activity] immediate flush failed:", err);
  }
}
