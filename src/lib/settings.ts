/**
 * GitMon extension — user-facing settings.
 *
 * Stored in `chrome.storage.sync` (NOT `local`) so the user's preferences
 * follow them across machines if Chrome Sync is enabled. Auth tokens go
 * in `local` because credentials should never sync — see `auth-bridge.ts`
 * for the deliberate split.
 *
 * Today the settings surface is small (one toggle), but the wrapper is
 * structured so V1 can add fields without rewriting consumers:
 *   - blocked_sites: string[]   (Phase 7b, when <all_urls> opens up)
 *   - notifications_enabled    (Phase 7b)
 *   - autonomous_comments + sub-toggles (Phase 7b §4.4)
 *
 * Reads default to "enabled = true" so a user who never opens the popup
 * still sees their GitMon — discoverability matters more than the
 * theoretical privacy gain of off-by-default for a sprite that only
 * renders on github.com.
 */

const SETTINGS_KEY = "gitmon_settings";

export interface ExtensionSettings {
  /** Master toggle: when false the content script does not inject anywhere. */
  enabled: boolean;
  /**
   * When false the periodic speech-bubble scheduler is muted: no LLM
   * call, no bubble rendered, no token spend. Default `true` so fresh
   * installs get the full experience; the mini-popup exposes a
   * "🔇 Mute speech" toggle for users who want silence (or to stop
   * burning their Anthropic/OpenAI quota). The sprite, drag, wander,
   * and click→popup behaviors are unaffected.
   */
  speech_enabled: boolean;
  /**
   * Privacy level (spec 10 §6.1). Controls what the extension collects:
   *  1 = Minimal (default): auth + settings + sprite state only.
   *  2 = Activity (opt-in): time on allowlisted dev sites (github.com).
   *  3 = Trends (opt-in): Level 2 + URL paths (anonymized).
   *  4 = Pro (paid, opt-in): Level 3 + idle/focus/attention.
   */
  privacy_level: 1 | 2 | 3 | 4;
  /**
   * Explicit opt-in for activity tracking. Must be `true` AND
   * `privacy_level >= 2` for the activity tracker to run. Two-key
   * design prevents accidental tracking if only one setting drifts.
   */
  enable_activity_tracking: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  speech_enabled: true,
  privacy_level: 1,
  enable_activity_tracking: false,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  // Merge with defaults so adding a new field doesn't break old installs.
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function updateSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * React-friendly subscription to settings changes. Returns an unsubscribe
 * function. The popup uses this to live-update its toggle UI when other
 * extension contexts (or Chrome Sync) write the settings.
 */
export function onSettingsChanged(
  cb: (settings: ExtensionSettings) => void,
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area !== "sync") return;
    if (!(SETTINGS_KEY in changes)) return;
    const next = changes[SETTINGS_KEY].newValue as Partial<ExtensionSettings> | undefined;
    cb({ ...DEFAULT_SETTINGS, ...(next ?? {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
