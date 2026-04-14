/**
 * GitMon extension — typed wrapper around chrome.storage.local for the
 * latest GitMon state pulled by the service worker.
 *
 * The SW writes here on every successful state pull (via chrome.alarms
 * every 60s + on-demand pulls); the popup and content scripts read here
 * to render the current state without each having to fetch the API
 * themselves. Single source of truth + low-cost storage broadcasts.
 *
 * Schema is intentionally a flat snapshot, not a stream of events. We
 * don't keep history client-side — the dashboard is the source of truth
 * for that.
 */

const STATE_KEY = "gitmon_state";
const STATE_FETCHED_AT_KEY = "gitmon_state_fetched_at";
const AI_CONFIG_KEY = "gitmon_ai_config";
const AI_CONFIG_FETCHED_AT_KEY = "gitmon_ai_config_fetched_at";

/**
 * Subset of the public API response that the extension actually renders.
 * Mirrors `/api/v1/public/gitmon/{username}` — keep in sync with that
 * endpoint when adding fields. Fields the renderer doesn't read are
 * intentionally omitted to keep the storage payload small.
 */
export interface GitMonStateSnapshot {
  species_id: string;
  species_name: string;
  nickname: string | null;
  level: number;
  evolution_stage: number;
  stage_name: string;
  status: string;
  hunger: number;
  happiness: number;
  energy: number;
  experience: number;
  hatch_progress: number;
  last_activity_at: string | null;
  // True for the first 5000 non-system profiles by created_at.
  // Surfaces a crown badge in the mini-popup. Optional on the snapshot for
  // backwards compatibility with storage written by earlier extension builds.
  is_founder?: boolean;
}

export async function getStoredState(): Promise<GitMonStateSnapshot | null> {
  const result = await chrome.storage.local.get(STATE_KEY);
  return (result[STATE_KEY] as GitMonStateSnapshot | undefined) ?? null;
}

export async function getStoredStateAge(): Promise<number | null> {
  const result = await chrome.storage.local.get(STATE_FETCHED_AT_KEY);
  const ts = result[STATE_FETCHED_AT_KEY] as number | undefined;
  if (!ts) return null;
  return Date.now() - ts;
}

export async function storeState(state: GitMonStateSnapshot): Promise<void> {
  await chrome.storage.local.set({
    [STATE_KEY]: state,
    [STATE_FETCHED_AT_KEY]: Date.now(),
  });
}

export async function clearStoredState(): Promise<void> {
  await chrome.storage.local.remove([STATE_KEY, STATE_FETCHED_AT_KEY]);
}

/**
 * AI personality config + minimal gitmon context cached from
 * `/api/extension/ai-config`. Used by the content script's speech-bubble
 * scheduler to build prompts and decide whether to call the LLM or fall
 * back to scripted phrases.
 *
 * The API key lives here in plaintext because that's how it lands in the
 * DB today (`gitmon_ai_config.llm_api_key_encrypted` is aspirationally
 * named — see `docs/spec/09-ai-personality.md`). `chrome.storage.local`
 * is extension-scoped so it never leaks to page JS.
 */
export interface AIConfigSnapshot {
  gitmon: {
    nickname: string | null;
    species_name: string;
    element: string;
    stage_name: string;
    status: string;
    hunger: number;
    happiness: number;
    energy: number;
  };
  ai: {
    provider: "anthropic" | "openai" | null;
    api_key: string | null;
    model: string | null;
    max_tokens: number;
    custom_prompt: string | null;
    trait_intelligence: number;
    trait_sarcasm: number;
    trait_humor: number;
    trait_irony: number;
    trait_aggression: number;
  };
}

export async function getStoredAIConfig(): Promise<AIConfigSnapshot | null> {
  const result = await chrome.storage.local.get(AI_CONFIG_KEY);
  return (result[AI_CONFIG_KEY] as AIConfigSnapshot | undefined) ?? null;
}

export async function storeAIConfig(config: AIConfigSnapshot): Promise<void> {
  await chrome.storage.local.set({
    [AI_CONFIG_KEY]: config,
    [AI_CONFIG_FETCHED_AT_KEY]: Date.now(),
  });
}

export async function clearStoredAIConfig(): Promise<void> {
  await chrome.storage.local.remove([AI_CONFIG_KEY, AI_CONFIG_FETCHED_AT_KEY]);
}
