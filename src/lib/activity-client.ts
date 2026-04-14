/**
 * Extension activity flush client.
 *
 * Reads queued activity events from chrome.storage.local and POSTs them
 * to the server. On success, clears the flushed entries. On failure
 * (network error, 503 feature-gated, etc.), leaves entries in storage
 * for the next retry.
 *
 * Shared between:
 * - service-worker (alarm-driven 5-minute flush)
 * - options page (manual "send now" button, future)
 */

const QUEUE_KEY = "gitmon_activity_queue";
const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

export interface ActivityEvent {
  site: string;
  minutes: number;
  ts: string; // ISO 8601
}

/** Append events to the storage queue. */
export async function enqueueEvents(events: ActivityEvent[]): Promise<void> {
  const result = await chrome.storage.local.get(QUEUE_KEY);
  const existing: ActivityEvent[] = result[QUEUE_KEY] ?? [];
  await chrome.storage.local.set({
    [QUEUE_KEY]: [...existing, ...events],
  });
}

/** Read current queue without clearing. */
export async function peekQueue(): Promise<ActivityEvent[]> {
  const result = await chrome.storage.local.get(QUEUE_KEY);
  return result[QUEUE_KEY] ?? [];
}

/**
 * Flush queued events to the server.
 * Returns the number of events accepted, or -1 on failure.
 */
export async function flushActivityBatch(
  sessionToken: string,
): Promise<number> {
  const queue = await peekQueue();
  if (queue.length === 0) return 0;

  // Send at most 100 events per request (server limit).
  const batch = queue.slice(0, 100);

  try {
    const res = await fetch(`${WEB_ORIGIN}/api/v1/extension/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ events: batch }),
    });

    if (!res.ok) {
      // 503 = feature flag off, 401 = bad token, 429 = rate limited.
      // All recoverable — leave queue intact for next flush.
      console.warn(
        "[gitmon activity] flush failed:",
        res.status,
        await res.text().catch(() => ""),
      );
      return -1;
    }

    const data = (await res.json()) as { accepted: number };

    // Clear only the events we successfully sent.
    const remaining = queue.slice(batch.length);
    await chrome.storage.local.set({ [QUEUE_KEY]: remaining });

    return data.accepted;
  } catch (err) {
    // Network error — keep queue for next flush.
    console.warn("[gitmon activity] flush network error:", err);
    return -1;
  }
}
