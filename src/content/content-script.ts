/**
 * GitMon extension — content script injected into github.com pages.
 *
 * M5: adds the click-to-mini-popup interaction (vitals + nav buttons),
 * click-vs-drag disambiguation, and respects the master "enabled" toggle
 * in the popup settings.
 *
 * M4 was: render the real PNG sprite + react to SW state pulls.
 * M5 layers on:
 *   - Mini-popup overlay inside the shadow root showing nickname, level,
 *     species, hunger/happiness/energy bars, status badge, and two CTAs
 *     (Open Dashboard / Visit World) that open in new tabs.
 *   - Click-vs-drag heuristic: pointerdown records start coords + time;
 *     pointerup checks total movement (< 5px) and elapsed (< 300ms) →
 *     treat as click and toggle the popup. Otherwise it was a drag.
 *   - Settings respect: reads `gitmon_settings.enabled` from
 *     chrome.storage.sync on mount; if false, the script does NOT inject
 *     anything. Subscribes to changes so toggling from the popup adds /
 *     removes the sprite live without a page refresh.
 *
 * Data flow recap:
 *
 *   service-worker (chrome.alarms 60s + on-demand)
 *      ↓ fetch /api/v1/public/gitmon/{username}
 *      ↓ chrome.tabs.sendMessage({ type: "gitmon:state:update", state })
 *   content-script (this file)
 *      ↓ render sprite + nickname + (when popup open) vitals bars
 *
 * State → visual mapping is unchanged from M4 (CSS keyframes per
 * data-state attribute, plus filter tweaks).
 *
 * Important file-order rule (TDZ — see commit history):
 *   The `STYLES` const is at the BOTTOM of this file. The `mount()` call
 *   that synchronously reads it must therefore also be at the bottom,
 *   AFTER the const declaration. Calling mount() near its definition
 *   (mid-file) will TDZ-crash in the minified bundle with a misleading
 *   "Cannot access 'Y' before initialization" error. Do not move it.
 */

import {
  resolveAnimationState,
  buildSpriteUrl,
  buildWalkSheetUrl,
  speciesHasWalkSheet,
  type AnimationState,
} from "@ext/sprite-engine";
import type { GitMonStateSnapshot, AIConfigSnapshot } from "@ext/lib/state-store";
import { getSettings, onSettingsChanged, updateSettings } from "@ext/lib/settings";
import { startWander, stopWander, isWandering } from "./wander";
import {
  startSpeechScheduler,
  stopSpeechScheduler,
  hideBubble,
  setAIConfig,
} from "./speech";

const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

const ROOT_ID = "gitmon-host";
const LOG_PREFIX = "[gitmon content]";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (...args: any[]) => console.log(LOG_PREFIX, ...args);

/** Click vs drag thresholds. Tuned for trackpad + mouse to feel natural. */
const CLICK_MOVE_PX = 5;
const CLICK_TIME_MS = 300;

type UI = {
  shadow: ShadowRoot;
  /** Wrapping div that clips the img so only one frame of the walk sheet is visible. */
  spriteEl: HTMLDivElement;
  /** The actual <img> that loads the PNG. MUST be an <img> tag — Chrome
   *  extensions' content scripts bypass the host page's `img-src` CSP when
   *  setting `.src` on an <img> element, but NOT when setting
   *  `background-image: url()` via CSS. GitHub's CSP has a strict img-src
   *  allowlist, so this is the only approach that works. */
  spriteImg: HTMLImageElement;
  spriteWrap: HTMLElement;
  placeholder: HTMLElement;
  label: HTMLElement;
  zzz: HTMLElement;
  popup: HTMLElement;
  popupBody: HTMLElement;
};

let ui: UI | null = null;
let currentState: GitMonStateSnapshot | null = null;
let popupOpen = false;
/**
 * Cached copy of the `speech_enabled` setting. Used by the scheduler
 * guard (via a `getSpeechEnabled` getter passed into
 * `startSpeechScheduler`) and by `renderPopupBody` to flip the
 * Mute/Unmute button label synchronously without an await. Kept in
 * sync by the `onSettingsChanged` listener in `boot()`.
 */
let speechEnabled = true;

/**
 * Last animation state the resolver produced from a SW snapshot. Stashed
 * so the wander loop can restore the correct idle-class state when it
 * stops (we can't call `applyState` at that moment — it would clobber
 * position writes). Read from `./wander.ts` via the exported getter.
 */
let lastResolvedState: AnimationState = "idle";

/** Read-only accessor for the wander module. */
export function getLastResolvedState(): AnimationState {
  return lastResolvedState;
}
/** Read-only accessor for the speech scheduler. */
export function getCurrentState(): GitMonStateSnapshot | null {
  return currentState;
}
export function isPopupOpen(): boolean {
  return popupOpen;
}

/* -------------------------------------------------------------------------- */
/*  Mount / unmount                                                            */
/* -------------------------------------------------------------------------- */

function alreadyInjected(): boolean {
  return document.getElementById(ROOT_ID) !== null;
}

function unmount(): void {
  stopWander();
  stopSpeechScheduler();
  const host = document.getElementById(ROOT_ID);
  if (host) host.remove();
  ui = null;
  popupOpen = false;
  log("unmounted");
}

function injectShadowRoot(): ShadowRoot {
  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 0",
    "height: 0",
    "z-index: 2147483647",
    "pointer-events: none",
  ].join(";");
  document.body.appendChild(host);
  return host.attachShadow({ mode: "closed" });
}

/**
 * Build the persistent UI tree once. Sprite + placeholder + zzz live
 * inside `wrap` so they share drag position. The mini-popup is a sibling
 * of the wrap so its absolute positioning is independent of drag offset
 * — it always anchors to the wrap's CURRENT bottom-right via JS on open.
 */
function buildUI(shadow: ShadowRoot): UI {
  const style = document.createElement("style");
  style.textContent = STYLES;
  shadow.appendChild(style);

  // ---- sprite wrap ----
  const wrap = document.createElement("div");
  wrap.className = "gm-wrap";

  const placeholder = document.createElement("div");
  placeholder.className = "gm-placeholder";
  placeholder.textContent = "G";
  placeholder.title = "GitMon — open the extension popup to connect";
  wrap.appendChild(placeholder);

  // Sprite: a clipping <div> + an <img> child. We need a real <img> so
  // that src-set loads bypass the host page's `img-src` CSP (GitHub has
  // a strict allowlist). The div clips the img so that for walk sheets
  // (288×96 when rendered 1.5×) only one 96×96 frame is visible at a
  // time, and a CSS `transform: translateX` animation with `steps(3)`
  // walks through the 3 frames.
  const spriteEl = document.createElement("div");
  spriteEl.className = "gm-sprite";
  spriteEl.style.display = "none";

  const spriteImg = document.createElement("img");
  spriteImg.className = "gm-sprite-img";
  spriteImg.alt = "GitMon";
  spriteImg.draggable = false;
  spriteEl.appendChild(spriteImg);
  wrap.appendChild(spriteEl);

  const zzz = document.createElement("div");
  zzz.className = "gm-zzz";
  zzz.textContent = "z z Z";
  zzz.style.display = "none";
  wrap.appendChild(zzz);

  // ---- floating label ----
  const label = document.createElement("div");
  label.className = "gm-label";
  label.textContent = "GitMon";

  // ---- mini popup ----
  const popup = document.createElement("div");
  popup.className = "gm-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "GitMon details");
  popup.style.display = "none";

  const popupBody = document.createElement("div");
  popupBody.className = "gm-popup-body";
  popup.appendChild(popupBody);

  shadow.appendChild(label);
  shadow.appendChild(popup);
  shadow.appendChild(wrap);

  wirePointer(wrap, label, popup);

  return { shadow, spriteEl, spriteImg, spriteWrap: wrap, placeholder, label, zzz, popup, popupBody };
}

/* -------------------------------------------------------------------------- */
/*  State application                                                          */
/* -------------------------------------------------------------------------- */

function applyState(state: GitMonStateSnapshot | null): void {
  if (!ui) return;
  currentState = state;

  if (!state) {
    ui.placeholder.style.display = "grid";
    ui.spriteEl.style.display = "none";
    ui.zzz.style.display = "none";
    ui.label.textContent = "Connect GitMon";
    ui.spriteWrap.dataset.state = "placeholder";
    if (popupOpen) closePopup(); // no state to show
    return;
  }

  const animState = resolveAnimationState(state);
  lastResolvedState = animState;

  // Pick the sprite source. Walk states (and the default idle-on-walk-sheet
  // path) use the 192×64 walk sheet rendered at 288×96 so the frame grid
  // lines up with `transform: translateX(-288px)` across `steps(3)`.
  // Sleeping uses the dedicated sleeping PNG. Eggs have no walk sheet.
  // Species with `walkStyle: "none"` (atom, slime, snake) also have no
  // walk sheet — fall back to the static idle PNG; drag/wander then
  // shows a still sprite instead of a broken 404 image.
  const isEgg = state.evolution_stage === 0;
  const useSleepSheet = animState === "sleeping";
  const noWalkSheet = !speciesHasWalkSheet(state.species_id);
  // Only load the walk spritesheet while the sprite is ACTIVELY moving
  // (user drag or autonomous wander). At rest, use the single-frame
  // `_idle.png` so the creature is perfectly still — the walk sheet's
  // 3 frames have subtle limb motion that reads as "swaying" even when
  // no CSS animation is cycling them. See 2026-04-14 feedback.
  const isActivelyMoving = isWandering() || ui.spriteWrap.classList.contains("dragging");
  const useIdlePng = isEgg || useSleepSheet || noWalkSheet || !isActivelyMoving;

  const url = useIdlePng
    ? buildSpriteUrl({
        species: state.species_id,
        stage: state.evolution_stage,
        state: animState,
      })
    : buildWalkSheetUrl({
        species: state.species_id,
        stage: state.evolution_stage,
      });

  // Write src on the <img>. This is critical: Chrome extensions'
  // content scripts bypass the page's `img-src` CSP for <img> src sets
  // but NOT for CSS `background-image: url()`. GitHub's CSP whitelists
  // only a handful of image hosts so the background-image approach
  // silently fails (image never paints). Do not refactor back.
  if (ui.spriteImg.src !== url) {
    ui.spriteImg.src = url;
  }
  // For the walk sheet we render at 288×96 (3 frames of 96×96 each).
  // The wrapping .gm-sprite div is overflow:hidden so only the frame at
  // the current `transform: translateX(...)` offset is visible.
  ui.spriteImg.style.width = useIdlePng ? "96px" : "288px";
  ui.spriteImg.style.height = "96px";
  ui.spriteEl.dataset.sheet = useIdlePng ? "static" : "walk";
  ui.spriteEl.style.display = "block";
  ui.placeholder.style.display = "none";
  ui.zzz.style.display = animState === "sleeping" ? "block" : "none";

  // Don't clobber the walking state while the user is actively driving
  // the sprite (drag or autonomous wander). The wander loop will call
  // this again via `stopWander()` when it finishes.
  const userDriven = isWandering() || (ui.spriteWrap.dataset.state === "walking" && ui.spriteWrap.classList.contains("dragging"));
  if (!userDriven) {
    ui.spriteWrap.dataset.state = animState;
  }

  const name = state.nickname?.trim() || state.species_name;
  ui.label.textContent = `${name}  ·  lv ${state.level}`;

  // Live-update popup contents if it's open right now.
  if (popupOpen) renderPopupBody(state);
}

/* -------------------------------------------------------------------------- */
/*  Mini-popup                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Render the popup body from a state snapshot. Called both on open and
 * on every applyState() while the popup is visible, so live SW pulls
 * (every 60s) keep the bars current without flicker — only innerHTML
 * is touched, the popup container stays mounted.
 */
function renderPopupBody(state: GitMonStateSnapshot): void {
  if (!ui) return;

  const name = state.nickname?.trim() || state.species_name;
  const statusLabel = statusBadgeLabel(state.status);
  const statusClass = `gm-badge gm-badge-${statusBadgeKind(state.status)}`;

  const founderBadge = state.is_founder
    ? `<div class="gm-founder-badge" title="Founder — one of the first 5000 pioneers">♛ Founder</div>`
    : "";

  ui.popupBody.innerHTML = `
    <button class="gm-popup-close" aria-label="Close">×</button>
    <div class="gm-popup-header">
      <div class="gm-popup-name">${escapeHtml(name)}</div>
      <div class="gm-popup-sub">
        ${escapeHtml(state.species_name)} · ${escapeHtml(state.stage_name)} · lv ${state.level}
      </div>
      ${founderBadge}
      <span class="${statusClass}">${statusLabel}</span>
    </div>

    <div class="gm-vitals">
      ${vitalRow("Hunger",    state.hunger,    "#f87171")}
      ${vitalRow("Happiness", state.happiness, "#fbbf24")}
      ${vitalRow("Energy",    state.energy,    "#60a5fa")}
    </div>

    <div class="gm-popup-actions">
      <button class="gm-popup-btn gm-popup-btn-primary" data-action="dashboard">
        Dashboard
      </button>
      <button class="gm-popup-btn gm-popup-btn-ghost" data-action="world">
        World
      </button>
    </div>
    <button class="gm-popup-btn gm-popup-btn-reset" data-action="toggle-speech" title="${
      speechEnabled
        ? "Stop the periodic speech bubbles and pause LLM token spend"
        : "Resume periodic speech bubbles"
    }">
      ${speechEnabled ? "🔇 Mute speech" : "🔊 Unmute speech"}
    </button>
    <button class="gm-popup-btn gm-popup-btn-reset" data-action="reset-position" title="Send GitMon back to the corner">
      ↩ Back to corner
    </button>
  `;

  // Wire button handlers (innerHTML throws away old listeners every render).
  ui.popupBody.querySelector(".gm-popup-close")?.addEventListener("click", closePopup);
  ui.popupBody.querySelectorAll<HTMLButtonElement>(".gm-popup-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "dashboard") openWebTab("/dashboard");
      else if (action === "world") openWebTab("/world");
      else if (action === "reset-position") resetPositionToCorner();
      else if (action === "toggle-speech") toggleSpeechEnabled();
    });
  });
}

/**
 * Flip the persistent `speech_enabled` setting. We write to
 * chrome.storage.sync and let the `onSettingsChanged` listener in
 * `boot()` propagate the change back through `speechEnabled`, the
 * popup re-render, and `hideBubble()`. Firing the side effects
 * through the storage listener (rather than inline here) guarantees
 * all open tabs react the same way — flipping mute in one tab mutes
 * every github.com tab the user has open.
 */
function toggleSpeechEnabled(): void {
  const next = !speechEnabled;
  updateSettings({ speech_enabled: next }).catch((err) => {
    log("toggle-speech updateSettings failed:", (err as Error).message);
  });
}

/**
 * Send the sprite back to its default bottom-right corner. Cancels any
 * active wander first so the RAF loop doesn't immediately overwrite the
 * reset, then clears the inline right/bottom styles so the CSS defaults
 * (`.gm-wrap { bottom: 24px; right: 24px }`) take over again. Also
 * resets facing + hides any visible bubble so the sprite looks clean
 * after the teleport.
 */
function resetPositionToCorner(): void {
  if (!ui) return;
  stopWander();
  hideBubble();
  // Clearing the inline properties lets the CSS rule apply again.
  ui.spriteWrap.style.removeProperty("right");
  ui.spriteWrap.style.removeProperty("bottom");
  ui.label.style.removeProperty("right");
  ui.label.style.removeProperty("bottom");
  delete ui.spriteWrap.dataset.facing;
  // Re-anchor the popup to the new sprite position if it's still open.
  if (popupOpen) {
    ui.popup.style.bottom = `${24 + 96 + 8}px`;
    ui.popup.style.right = `24px`;
  }
  closePopup();
}

function vitalRow(label: string, value: number, color: string): string {
  const pct = Math.max(0, Math.min(100, value));
  return `
    <div class="gm-vital">
      <div class="gm-vital-row">
        <span class="gm-vital-label">${label}</span>
        <span class="gm-vital-value">${pct}</span>
      </div>
      <div class="gm-vital-bar">
        <div class="gm-vital-fill" style="width: ${pct}%; background: ${color};"></div>
      </div>
    </div>
  `;
}

function statusBadgeLabel(status: string): string {
  switch (status) {
    case "alive": return "Alive";
    case "egg": return "Egg";
    case "hatching": return "Hatching";
    case "sleeping": return "Sleeping";
    case "hungry": return "Hungry";
    case "critical": return "Critical";
    case "dead": return "Dead";
    default: return status;
  }
}

function statusBadgeKind(status: string): string {
  if (status === "dead") return "danger";
  if (status === "critical" || status === "hungry") return "warn";
  if (status === "egg" || status === "hatching") return "info";
  return "ok";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!;
  });
}

/**
 * Open a tab on the GitMon web app. Content scripts can't call
 * chrome.tabs.create directly without the `tabs` permission, but
 * window.open works inside a user gesture (click handler).
 */
function openWebTab(path: string): void {
  window.open(`${WEB_ORIGIN}${path}`, "_blank", "noopener,noreferrer");
  closePopup();
}

function openPopup(): void {
  if (!ui) return;
  if (!currentState) return; // nothing to show — placeholder mode
  popupOpen = true;
  ui.popup.style.display = "block";
  renderPopupBody(currentState);
  // Position the popup so its bottom-right anchors above the sprite's
  // top edge. We read the wrap's computed bottom/right because drag may
  // have moved it from the default 24/24.
  const cs = getComputedStyle(ui.spriteWrap);
  const wrapBottom = parseFloat(cs.bottom) || 24;
  const wrapRight = parseFloat(cs.right) || 24;
  ui.popup.style.bottom = `${wrapBottom + 96 + 8}px`; // 96 = wrap height, 8 = gap
  ui.popup.style.right = `${wrapRight}px`;
  // Outside-click listener installed once on open, removed on close.
  setTimeout(() => document.addEventListener("pointerdown", outsideClickHandler, true), 0);
}

function closePopup(): void {
  if (!ui) return;
  popupOpen = false;
  ui.popup.style.display = "none";
  document.removeEventListener("pointerdown", outsideClickHandler, true);
}

/**
 * Outside-click handler. We listen on the page document (capture phase)
 * because clicks inside the shadow root surface as a click on the host
 * div from the page's POV.
 *
 * IMPORTANT: the shadow root was created with `mode: "closed"`, so from
 * the document's perspective every event that originates inside the
 * shadow is retargeted to the shadow HOST and `composedPath()` is
 * truncated at the host boundary. We therefore CANNOT look for
 * `ui.popup` inside composedPath() — it's never there. The correct
 * check is: if the event's target (as seen from outside) is the host
 * element, the click came from somewhere inside our shadow tree and we
 * must keep the popup open. Otherwise it was a real outside click.
 *
 * A prior version of this handler used `composedPath().includes(popup)`
 * which always evaluated false → any button click inside the popup
 * (Dashboard, World, Back to corner) instantly closed it in the
 * pointerdown phase before the button's own click handler could run.
 */
function outsideClickHandler(e: PointerEvent): void {
  if (!ui) return;
  const host = document.getElementById(ROOT_ID);
  if (host && e.target === host) {
    return; // click originated inside the closed shadow — ignore
  }
  closePopup();
}

/* -------------------------------------------------------------------------- */
/*  Pointer (drag + click)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Single pointer handler that decides at pointerup whether the gesture
 * was a drag or a click. Click → toggle popup. Drag → mutate position
 * (and close popup if open, since dragging through it would be weird).
 */
function wirePointer(wrap: HTMLElement, label: HTMLElement, popup: HTMLElement): void {
  let pressed = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let startRight = 24;
  let startBottom = 24;
  let startLabelRight = 20;
  let startLabelBottom = 96;
  let lastDragX = 0;

  const cur = (el: HTMLElement) => {
    const cs = getComputedStyle(el);
    return {
      right: parseFloat(cs.right) || 0,
      bottom: parseFloat(cs.bottom) || 0,
    };
  };

  wrap.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // Any active wander ends the moment the user grabs the sprite.
    // Read the DOM-truth position AFTER stopWander so we don't latch
    // onto stale right/bottom values from before the wander loop.
    stopWander();
    hideBubble();

    pressed = true;
    moved = false;
    wrap.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    lastDragX = e.clientX;
    startTime = performance.now();
    const w = cur(wrap);
    startRight = w.right;
    startBottom = w.bottom;
    const l = cur(label);
    startLabelRight = l.right;
    startLabelBottom = l.bottom;
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!pressed) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > CLICK_MOVE_PX) {
      moved = true;
      wrap.classList.add("dragging");
      wrap.dataset.state = "walking";
      // Swap to the walk spritesheet now that the sprite is actively
      // moving (applyState reads the `dragging` class to pick the src).
      if (currentState) applyState(currentState);
      // Drag overrides click — close popup if it was open from a previous click.
      if (popupOpen) closePopup();
    }
    if (!moved) return;

    // Facing based on incremental X delta, not cumulative: the user can
    // reverse direction mid-drag and the sprite should flip instantly.
    const dxStep = e.clientX - lastDragX;
    if (dxStep < -0.1) wrap.dataset.facing = "L";
    else if (dxStep > 0.1) wrap.dataset.facing = "R";
    lastDragX = e.clientX;

    const newRight = Math.max(4, startRight - dx);
    const newBottom = Math.max(4, startBottom - dy);
    wrap.style.right = `${newRight}px`;
    wrap.style.bottom = `${newBottom}px`;
    label.style.right = `${Math.max(0, startLabelRight - dx)}px`;
    label.style.bottom = `${Math.max(0, startLabelBottom - dy)}px`;
    // Keep popup anchored to sprite during drag (only matters if we
    // re-enabled drag-while-popup-open later — currently popup closes
    // on drag start so this is a no-op for the common path).
    if (popupOpen) {
      popup.style.right = `${newRight}px`;
      popup.style.bottom = `${newBottom + 96 + 8}px`;
    }
  });

  const endPointer = (e: PointerEvent) => {
    if (!pressed) return;
    pressed = false;
    wrap.classList.remove("dragging");
    try {
      wrap.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Click classification: didn't move much AND didn't take long.
    const elapsed = performance.now() - startTime;
    if (!moved && elapsed < CLICK_TIME_MS) {
      // Toggle popup. Skip if we're in placeholder mode (no state to show).
      if (popupOpen) closePopup();
      else openPopup();
      return;
    }
    // Actual drag → hand off to the autonomous wander loop so the sprite
    // keeps walking around for a few seconds before settling.
    if (moved && currentState) {
      startWander({
        wrap,
        label,
        resolveIdle: () => lastResolvedState,
        // Wander just stopped — refresh the sprite so the img src flips
        // back from walk sheet (288×96) to static _idle.png (96×96).
        onStop: () => {
          if (currentState) applyState(currentState);
        },
      });
    }
  };
  wrap.addEventListener("pointerup", endPointer);
  wrap.addEventListener("pointercancel", endPointer);
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                     */
/* -------------------------------------------------------------------------- */

async function pullInitialState(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: "gitmon:state:get" })) as
      | { ok: boolean; state?: GitMonStateSnapshot | null; error?: string }
      | undefined;
    if (!res?.ok) {
      log("state:get failed:", res?.error ?? "no response");
      applyState(null);
      return;
    }
    applyState(res.state ?? null);
  } catch (err) {
    log("state:get threw:", (err as Error).message);
    applyState(null);
  }
}

async function pullInitialAIConfig(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "gitmon:ai-config:get",
    })) as
      | { ok: boolean; config?: AIConfigSnapshot | null; error?: string }
      | undefined;
    if (!res?.ok) {
      log("ai-config:get failed:", res?.error ?? "no response");
      setAIConfig(null);
      return;
    }
    setAIConfig(res.config ?? null);
  } catch (err) {
    log("ai-config:get threw:", (err as Error).message);
    setAIConfig(null);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "gitmon:state:update") {
    applyState((msg.state as GitMonStateSnapshot | null) ?? null);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "gitmon:ai-config:update") {
    setAIConfig((msg.config as AIConfigSnapshot | null) ?? null);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function mountIfEnabled(): void {
  if (alreadyInjected()) {
    log("already injected — skipping");
    return;
  }
  const shadow = injectShadowRoot();
  ui = buildUI(shadow);
  applyState(null); // start in placeholder mode until SW responds
  pullInitialState();
  pullInitialAIConfig();
  startSpeechScheduler({
    wrap: ui.spriteWrap,
    shadow,
    getCurrentState: () => currentState,
    isPopupOpen: () => popupOpen,
    getSpeechEnabled: () => speechEnabled,
  });
  log("injected on", window.location.href);
}

/**
 * Boot: read settings, mount only if enabled, subscribe to changes so
 * the user can flip toggles from the popup and see them apply live.
 *
 * Two independent settings are watched:
 *   - `enabled` (master): mounts/unmounts the entire UI
 *   - `speech_enabled`: toggles the speech-bubble scheduler without
 *     touching the sprite, drag, or popup behavior. When it flips to
 *     false we also hide any currently visible bubble and re-render
 *     the popup body (if open) so the button label flips immediately.
 */
async function boot(): Promise<void> {
  const settings = await getSettings();
  speechEnabled = settings.speech_enabled;
  if (settings.enabled) {
    mountIfEnabled();
  } else {
    log("settings.enabled = false — sprite hidden, waiting for toggle");
  }

  onSettingsChanged((next) => {
    if (next.enabled && !ui) {
      mountIfEnabled();
    } else if (!next.enabled && ui) {
      unmount();
      return;
    }

    if (next.speech_enabled !== speechEnabled) {
      speechEnabled = next.speech_enabled;
      log("speech_enabled →", speechEnabled);
      if (!speechEnabled) hideBubble();
      if (popupOpen && currentState) renderPopupBody(currentState);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Styles                                                                     */
/* -------------------------------------------------------------------------- */

const STYLES = `
:host {
  all: initial;
}

.gm-wrap {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 96px;
  height: 96px;
  display: grid;
  place-items: center;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  will-change: transform;
}
.gm-wrap.dragging {
  cursor: grabbing;
}

.gm-placeholder {
  width: 64px;
  height: 64px;
  border-radius: 12px;
  background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35),
              0 0 0 1px rgba(255, 255, 255, 0.08);
  display: grid;
  place-items: center;
  color: white;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-weight: 800;
  font-size: 28px;
  transition: transform 160ms ease;
}
.gm-wrap:hover .gm-placeholder {
  transform: translateY(-2px);
}

/* The sprite is a two-level structure:
   - .gm-sprite: a 96×96 overflow:hidden clipping window.
   - .gm-sprite-img: the actual <img> (its src is written from applyState).
     For walk sheets it is sized 288×96 (3 frames) and translateX'd in
     steps of 96px to cycle through frames; for idle PNGs it is 96×96
     and sits at translateX(0). */
.gm-sprite {
  width: 96px;
  height: 96px;
  overflow: hidden;
  filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.35));
  pointer-events: none;
  transition: filter 240ms ease;
}
.gm-sprite-img {
  display: block;
  width: 96px;
  height: 96px;
  image-rendering: pixelated;
  image-rendering: -moz-crisp-edges;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}
/* Flip the sprite when facing left (dx < 0). Applied to the clipping
   wrapper so the 3-frame translateX walk animation (which lives on the
   img) still cycles correctly — scale and translate compose. */
.gm-wrap[data-facing="L"] .gm-sprite {
  transform: scaleX(-1);
}

.gm-label {
  position: fixed;
  bottom: 128px;
  right: 20px;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(15, 15, 20, 0.85);
  padding: 4px 9px;
  border-radius: 6px;
  backdrop-filter: blur(4px);
  pointer-events: none;
  letter-spacing: 0.02em;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.gm-zzz {
  position: absolute;
  top: -4px;
  right: 4px;
  font-family: ui-monospace, monospace;
  font-size: 14px;
  font-weight: 700;
  color: #c4b5fd;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  letter-spacing: 2px;
  pointer-events: none;
  animation: gm-zzz-float 2.4s ease-in-out infinite;
}
@keyframes gm-zzz-float {
  0%, 100% { transform: translateY(0); opacity: 0.8; }
  50%      { transform: translateY(-4px); opacity: 1; }
}

/* ---------- per-state effects ---------- */

/* The vitals-state animations (bob/bounce/jitter/breath/wobble) live on
   the .gm-sprite-img so they don't interfere with the wrapper's scaleX
   flip or the walk sheet clipping. Filters live on the wrapper so the
   drop shadow + tints still wrap around the clipped content. */
/* When the sprite is not actively being dragged or wandering, it must
   be 100% still — any loop steals peripheral attention from the user's
   code. Vitals states still set data-state so the color filters below
   communicate status; only the motion is stripped. Hatching keeps its
   wobble (brief event, not a sustained state) and walking keeps the
   3-frame cycle (core feature). */
.gm-wrap[data-state="idle"] .gm-sprite-img,
.gm-wrap[data-state="happy"] .gm-sprite-img,
.gm-wrap[data-state="hungry"] .gm-sprite-img,
.gm-wrap[data-state="critical"] .gm-sprite-img,
.gm-wrap[data-state="sleeping"] .gm-sprite-img,
.gm-wrap[data-state="dead"] .gm-sprite-img {
  animation: none;
}
.gm-wrap[data-state="happy"] .gm-sprite {
  filter: drop-shadow(0 6px 10px rgba(0,0,0,0.35)) brightness(1.12) saturate(1.2);
}
.gm-wrap[data-state="hungry"] .gm-sprite {
  filter: drop-shadow(0 6px 10px rgba(0,0,0,0.35)) saturate(0.7);
}
.gm-wrap[data-state="critical"] .gm-sprite {
  filter: drop-shadow(0 6px 10px rgba(0,0,0,0.35)) hue-rotate(-10deg) brightness(0.95);
}
.gm-wrap[data-state="sleeping"] .gm-sprite {
  filter: drop-shadow(0 6px 10px rgba(0,0,0,0.35)) brightness(0.85) saturate(0.85);
}
.gm-wrap[data-state="dead"] .gm-sprite {
  filter: drop-shadow(0 6px 10px rgba(0,0,0,0.35)) grayscale(1) opacity(0.55);
}
.gm-wrap[data-state="hatching"] .gm-sprite-img {
  animation: gm-wobble 0.9s ease-in-out infinite;
}
/* Walk state: the wrapper clips to 96×96 and the img is 288×96. We
   translateX through the 3 frames with steps(3). Frame 0 = neutral
   idle pose, so the first frame of the loop matches the static state. */
.gm-wrap[data-state="walking"] .gm-sprite-img {
  animation: gm-walk 0.42s steps(3) infinite;
}
@keyframes gm-walk {
  from { transform: translateX(0); }
  to   { transform: translateX(-288px); }
}

@keyframes gm-bob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-3px); }
}
@keyframes gm-bounce {
  0%, 100% { transform: translateY(0)    scale(1); }
  50%      { transform: translateY(-6px) scale(1.04); }
}
@keyframes gm-breath {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.02); }
}
@keyframes gm-jitter {
  0%   { transform: translate(0, 0); }
  25%  { transform: translate(-1px, 0.5px); }
  50%  { transform: translate(0.5px, -1px); }
  75%  { transform: translate(-0.5px, 1px); }
  100% { transform: translate(0, 0); }
}
@keyframes gm-wobble {
  0%, 100% { transform: rotate(-3deg); }
  50%      { transform: rotate(3deg); }
}

/* ---------- mini popup ---------- */

.gm-popup {
  position: fixed;
  width: 260px;
  background: rgba(15, 15, 20, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55),
              0 0 0 1px rgba(168, 85, 247, 0.15);
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #e6e6ea;
  backdrop-filter: blur(12px);
  animation: gm-popup-in 160ms ease-out;
}

@keyframes gm-popup-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.gm-popup-body {
  position: relative;
  padding: 16px;
}

.gm-popup-close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 22px;
  height: 22px;
  border: none;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  display: grid;
  place-items: center;
  font-family: inherit;
}
.gm-popup-close:hover {
  background: rgba(255, 255, 255, 0.12);
  color: white;
}

.gm-popup-header {
  margin-bottom: 14px;
  padding-right: 24px;
}

.gm-popup-name {
  font-size: 15px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 0.01em;
}

.gm-popup-sub {
  font-size: 11px;
  color: #8888a0;
  margin-top: 3px;
  letter-spacing: 0.02em;
}

.gm-founder-badge {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  background: rgba(232, 121, 249, 0.15);
  color: #f0abfc;
  border: 1px solid rgba(232, 121, 249, 0.35);
}

.gm-badge {
  display: inline-block;
  margin-top: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.gm-badge-ok     { background: rgba(74, 222, 128, 0.15); color: #86efac; }
.gm-badge-warn   { background: rgba(251, 191, 36, 0.15); color: #fcd34d; }
.gm-badge-danger { background: rgba(248, 113, 113, 0.18); color: #fca5a5; }
.gm-badge-info   { background: rgba(96, 165, 250, 0.18); color: #93c5fd; }

.gm-vitals {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-bottom: 14px;
}

.gm-vital-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 10px;
}

.gm-vital-label {
  color: #b0b0c0;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.gm-vital-value {
  color: #ffffff;
  font-weight: 700;
  font-family: ui-monospace, "JetBrains Mono", monospace;
}

.gm-vital-bar {
  height: 5px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  overflow: hidden;
}

.gm-vital-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 360ms ease;
}

.gm-popup-actions {
  display: flex;
  gap: 8px;
}

.gm-popup-btn {
  flex: 1;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  transition: filter 120ms ease, transform 120ms ease;
}
.gm-popup-btn:active { transform: scale(0.97); }

.gm-popup-btn-primary {
  background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
  color: white;
}
.gm-popup-btn-primary:hover { filter: brightness(1.1); }

.gm-popup-btn-ghost {
  background: rgba(255, 255, 255, 0.06);
  color: #c0c0d0;
}
.gm-popup-btn-ghost:hover { background: rgba(255, 255, 255, 0.12); }

.gm-popup-btn-reset {
  width: 100%;
  margin-top: 8px;
  padding: 7px 10px;
  background: transparent;
  color: #8888a0;
  border: 1px dashed rgba(255, 255, 255, 0.14);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.gm-popup-btn-reset:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #c0c0d0;
  border-color: rgba(255, 255, 255, 0.22);
}

/* ---------- speech bubble ---------- */

.gm-bubble {
  position: absolute;
  left: 50%;
  bottom: calc(100% - 4px);
  transform: translateX(-50%) translateY(4px);
  max-width: 180px;
  min-width: 40px;
  padding: 6px 9px;
  background: #ffffff;
  color: #111111;
  border: 3px solid #111111;
  border-radius: 8px;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.35);
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 10px;
  line-height: 1.35;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: normal;
  word-wrap: break-word;
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 180ms ease, transform 180ms ease;
  z-index: 2;
}
.gm-bubble.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.gm-bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -8px;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 8px solid #111111;
}
.gm-bubble::before {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -4px;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid #ffffff;
  z-index: 1;
}
`;

// Kick off boot at the BOTTOM of the file, after STYLES is declared.
// See TDZ note at top of file. Do not move.
boot();
