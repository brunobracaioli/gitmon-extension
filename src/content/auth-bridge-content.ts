/**
 * GitMon extension — auth bridge content script.
 *
 * Loaded ONLY on the GitMon web /extension/connect page (narrow match in
 * manifest.json). Its single job: listen for the postMessage that the
 * connect page emits with the one-time token, and relay it via
 * chrome.runtime.sendMessage so the popup's auth-bridge.ts listener can
 * pick it up.
 *
 * Why a separate content script instead of doing this in the main
 * content script (content-script.ts on github.com): the main content
 * script doesn't run on our own web origin, and we don't want to.
 * Cleaner separation of concerns + the auth bridge content script is
 * 30 lines and has no other responsibilities.
 *
 * Origin guard: we only accept messages whose origin matches our web
 * app exactly. Without this guard, any page could spoof a connect
 * message and steal the OTT.
 */

// Injected at build time by Vite's `define` (vite.config.ts). Same value
// the manifest.config.ts uses for the matches[] pattern, so origin guard
// and content script registration are always in lockstep.
const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;

window.addEventListener("message", (event) => {
  if (event.origin !== WEB_ORIGIN) return;
  const data = event.data as { type?: string; ott?: string } | null;
  if (!data || data.type !== "gitmon:extension:handoff") return;
  if (typeof data.ott !== "string" || data.ott.length !== 64) return;
  // Forward to extension runtime. The popup listener picks it up.
  chrome.runtime
    .sendMessage({ type: "gitmon:extension:handoff", ott: data.ott })
    .catch(() => { /* popup may have closed — ignore */ });
});

// eslint-disable-next-line no-console
console.log("[gitmon auth-bridge] listener mounted");
