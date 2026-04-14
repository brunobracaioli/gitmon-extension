/**
 * Autonomous speech bubble scheduler for the companion sprite.
 *
 * Every 60–180s (random), picks a "kind" (species / repo / random),
 * builds a prompt, calls the client-side LLM with the user's own API
 * key, and renders a pixel-art speech bubble above the sprite. Falls
 * back to scripted phrases on any failure so the feature still fires
 * visibly even without an LLM key configured.
 *
 * The scheduler lives in the content script (not the service worker)
 * because the bubble DOM and the LLM fetch both need to run in the
 * page's content-script origin:
 *  - Bubble → must be inserted into the shadow root.
 *  - LLM fetch → Anthropic accepts `anthropic-dangerous-direct-browser-access`
 *    only from a real browser context.
 *
 * Guard chain: many states should suppress the tick (popup open, drag,
 * wander, tab hidden, no state). In those cases the scheduler just
 * re-arms for 20s instead of consuming the slot.
 */

import type { AIConfigSnapshot, GitMonStateSnapshot } from "@ext/lib/state-store";
import { callExtLLM, type LLMProvider } from "@ext/lib/llm-client";
import { buildExtSystemPrompt } from "@ext/lib/ai-prompt";
import { getFallbackPhrase, getRandomFlavorLine } from "@ext/lib/ai-fallback";
import { getGithubContext } from "@ext/lib/github-context";
import { isWandering } from "./wander";

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 180_000;
const GUARD_RETRY_MS = 20_000;
const BUBBLE_HOLD_MS = 5_000;
const BUBBLE_FADE_MS = 220;
const MAX_BUBBLE_CHARS = 140;

type Kind = "species" | "repo" | "random";
const KIND_ORDER: Kind[] = ["species", "repo", "random"];

interface SchedulerState {
  timer: number | null;
  wrap: HTMLElement | null;
  shadow: ShadowRoot | null;
  aiConfig: AIConfigSnapshot | null;
  getCurrentState: () => GitMonStateSnapshot | null;
  isPopupOpen: () => boolean;
  getSpeechEnabled: () => boolean;
  kindIndex: number;
  currentBubble: HTMLDivElement | null;
  bubbleHideTimer: number | null;
  bubbleRemoveTimer: number | null;
}

const s: SchedulerState = {
  timer: null,
  wrap: null,
  shadow: null,
  aiConfig: null,
  getCurrentState: () => null,
  isPopupOpen: () => false,
  getSpeechEnabled: () => true,
  kindIndex: 0,
  currentBubble: null,
  bubbleHideTimer: null,
  bubbleRemoveTimer: null,
};

export interface SpeechSchedulerOptions {
  wrap: HTMLElement;
  shadow: ShadowRoot;
  getCurrentState: () => GitMonStateSnapshot | null;
  isPopupOpen: () => boolean;
  /**
   * Live-read of the user's "speech enabled" setting. When this
   * returns false the scheduler skips the current tick (no LLM call,
   * no bubble, no token spend) and just re-schedules 20s later, so
   * flipping the setting back on resumes speech within 20s without
   * needing to restart the scheduler.
   */
  getSpeechEnabled: () => boolean;
}

/** Start (or restart) the scheduler. Idempotent: wipes any existing timer. */
export function startSpeechScheduler(opts: SpeechSchedulerOptions): void {
  stopSpeechScheduler();
  s.wrap = opts.wrap;
  s.shadow = opts.shadow;
  s.getCurrentState = opts.getCurrentState;
  s.isPopupOpen = opts.isPopupOpen;
  s.getSpeechEnabled = opts.getSpeechEnabled;
  scheduleNext(randRange(MIN_INTERVAL_MS, MAX_INTERVAL_MS));
}

/** Stop the scheduler and remove any visible bubble. */
export function stopSpeechScheduler(): void {
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  hideBubble();
  s.wrap = null;
  s.shadow = null;
}

/** Called by the content script when the SW broadcasts a new AI config. */
export function setAIConfig(config: AIConfigSnapshot | null): void {
  s.aiConfig = config;
}

function scheduleNext(delayMs: number): void {
  if (s.timer !== null) clearTimeout(s.timer);
  s.timer = window.setTimeout(() => {
    fire().catch(() => {
      /* never throw from a timer */
    });
  }, delayMs);
}

async function fire(): Promise<void> {
  s.timer = null;

  // Guard chain — if any gate blocks, retry in 20s without burning
  // the normal 60–180s slot. The `!s.getSpeechEnabled()` check is
  // first-class here (not just an early return) so the scheduler
  // keeps ticking while muted — as soon as the user unmutes, the
  // next 20s tick proceeds normally, no restart needed.
  if (
    !s.wrap ||
    !s.shadow ||
    !s.getSpeechEnabled() ||
    s.isPopupOpen() ||
    isWandering() ||
    document.hidden ||
    s.currentBubble !== null ||
    s.getCurrentState() === null
  ) {
    scheduleNext(GUARD_RETRY_MS);
    return;
  }

  const state = s.getCurrentState();
  if (!state) {
    scheduleNext(GUARD_RETRY_MS);
    return;
  }

  const kind = pickNextKind();
  const text = await resolveLine(kind, state);

  // Guard again — user might have opened popup / started dragging
  // during the LLM round trip.
  if (
    !s.wrap ||
    !s.shadow ||
    s.isPopupOpen() ||
    isWandering() ||
    s.currentBubble !== null
  ) {
    scheduleNext(GUARD_RETRY_MS);
    return;
  }

  showBubble(text);
  scheduleNext(randRange(MIN_INTERVAL_MS, MAX_INTERVAL_MS));
}

function pickNextKind(): Kind {
  // Rotate, but skip `repo` if we're not on a repo page — the line
  // would be nonsense. We still count the skip so rotation stays even.
  for (let i = 0; i < KIND_ORDER.length; i++) {
    const candidate = KIND_ORDER[s.kindIndex % KIND_ORDER.length];
    s.kindIndex = (s.kindIndex + 1) % KIND_ORDER.length;
    if (candidate === "repo" && getGithubContext().page !== "repo") continue;
    return candidate;
  }
  return "random";
}

async function resolveLine(
  kind: Kind,
  state: GitMonStateSnapshot,
): Promise<string> {
  const config = s.aiConfig;

  // No config or no LLM key → straight to scripted pool.
  if (!config || !config.ai.provider || !config.ai.api_key) {
    return fallbackLineFor(kind, state, config);
  }

  const system = buildExtSystemPrompt(
    {
      nickname: config.gitmon.nickname,
      species_name: config.gitmon.species_name,
      element: config.gitmon.element,
      stage_name: config.gitmon.stage_name,
      status: state.status,
    },
    {
      trait_intelligence: config.ai.trait_intelligence,
      trait_sarcasm: config.ai.trait_sarcasm,
      trait_humor: config.ai.trait_humor,
      trait_irony: config.ai.trait_irony,
      trait_aggression: config.ai.trait_aggression,
      custom_prompt: config.ai.custom_prompt,
    },
  );

  const user = buildUserPrompt(kind, config);

  const result = await callExtLLM(
    {
      provider: config.ai.provider as LLMProvider,
      apiKey: config.ai.api_key,
      model: config.ai.model ?? "",
      maxTokens: Math.min(80, config.ai.max_tokens ?? 60),
    },
    system,
    user,
  );

  if (!result.ok || !result.content.trim()) {
    return fallbackLineFor(kind, state, config);
  }
  return truncate(result.content.trim(), MAX_BUBBLE_CHARS);
}

function buildUserPrompt(kind: Kind, config: AIConfigSnapshot): string {
  const g = config.gitmon;
  if (kind === "species") {
    return `Say one playful line (under 80 characters) about being a ${g.species_name} (${g.element}) at the ${g.stage_name} stage. Plain text only. No hashtags.`;
  }
  if (kind === "repo") {
    const ctx = getGithubContext();
    const title = ctx.title.trim();
    const desc = ctx.description.trim();
    return `I am currently viewing the GitHub repo ${ctx.owner}/${ctx.repo}.${
      title ? ` Page title: "${title}".` : ""
    }${
      desc ? ` Description: "${desc}".` : ""
    } Say one short in-character comment (under 90 characters) about this repo. Plain text only. No hashtags, no URLs.`;
  }
  return `Say one short in-character remark (under 80 characters) — random flavor, no repo or species reference needed. Plain text only. No hashtags.`;
}

function fallbackLineFor(
  kind: Kind,
  state: GitMonStateSnapshot,
  config: AIConfigSnapshot | null,
): string {
  if (kind === "random") return getRandomFlavorLine();
  const element = config?.gitmon.element ?? "default";
  const status = normalizeStatusForFallback(state.status);
  return getFallbackPhrase(element, status);
}

function normalizeStatusForFallback(status: string): string {
  // The fallback pool is keyed on a smaller set than the server's
  // status enum. Map everything down to one of the buckets that
  // `ai-fallback.ts` understands.
  switch (status) {
    case "dead":
    case "sleeping":
    case "hungry":
    case "critical":
      return status;
    case "happy":
      return "happy";
    case "alive":
    case "egg":
    case "hatching":
    default:
      return "alive";
  }
}

/* -------------------------------------------------------------------------- */
/*  Bubble DOM                                                                 */
/* -------------------------------------------------------------------------- */

function showBubble(text: string): void {
  if (!s.wrap) return;
  if (s.currentBubble) hideBubble(); // single-bubble invariant

  const bubble = document.createElement("div");
  bubble.className = "gm-bubble";
  bubble.textContent = text;
  s.wrap.appendChild(bubble);
  s.currentBubble = bubble;

  // Next frame → fade in by adding .visible so the CSS transition fires.
  requestAnimationFrame(() => {
    bubble.classList.add("visible");
  });

  s.bubbleHideTimer = window.setTimeout(() => {
    if (!bubble.isConnected) return;
    bubble.classList.remove("visible");
    s.bubbleRemoveTimer = window.setTimeout(() => {
      if (bubble.parentElement) bubble.parentElement.removeChild(bubble);
      if (s.currentBubble === bubble) s.currentBubble = null;
    }, BUBBLE_FADE_MS + 40);
  }, BUBBLE_HOLD_MS);
}

/** Immediately remove any visible bubble. Safe to call when no bubble exists. */
export function hideBubble(): void {
  if (s.bubbleHideTimer !== null) {
    clearTimeout(s.bubbleHideTimer);
    s.bubbleHideTimer = null;
  }
  if (s.bubbleRemoveTimer !== null) {
    clearTimeout(s.bubbleRemoveTimer);
    s.bubbleRemoveTimer = null;
  }
  if (s.currentBubble && s.currentBubble.parentElement) {
    s.currentBubble.parentElement.removeChild(s.currentBubble);
  }
  s.currentBubble = null;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + "…";
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
