import { defineManifest } from "@crxjs/vite-plugin";

/**
 * GitMon extension manifest — dynamic so dev and prod can be loaded as
 * SEPARATE extensions in the same Chrome instance, with different names,
 * different icons, different host permissions, and isolated storage.
 *
 * Why dynamic instead of `manifest.json`:
 *   - Avoid manually swapping `WEB_ORIGIN` between localhost and prod
 *     every time we want to test a backend change.
 *   - Two visually-distinct extensions side-by-side in the toolbar (purple
 *     for prod, orange for dev) so we can never accidentally test the
 *     wrong one.
 *   - chrome.storage.local is namespaced per-extension by default, so the
 *     dev and prod sessions don't collide.
 *
 * Vite passes `env.mode` based on the build command:
 *   - `vite build`                 → mode = "production"
 *   - `vite build --mode development` → mode = "development"
 *   - `vite --mode development`    → dev server, mode = "development"
 *
 * The runtime TS files (auth-bridge.ts, auth-bridge-content.ts) read
 * `import.meta.env.MODE` and `import.meta.env.VITE_WEB_ORIGIN` (which we
 * inject below via define) so they always agree with the manifest.
 */
export default defineManifest((env) => {
  const isDev = env.mode === "development";
  // Prod canonical origin is the apex https://gitmon.io. Vercel is
  // configured with apex as primary and www.gitmon.io → 307 → apex,
  // so the extension fetches the canonical directly — no redirect
  // hop, no fetch() redirect:'follow' edge cases. The vercel-assigned
  // `gitmon-gilt.vercel.app` alias still resolves but we deliberately
  // keep it out of the Chrome Web Store host permissions (looks
  // unfinished and locks us to Vercel). Changing this origin after
  // the first store submission forces a major version bump plus all
  // existing users re-accepting permissions, so keep it stable.
  const WEB_ORIGIN = isDev
    ? "http://localhost:3000"
    : "https://gitmon.io";

  return {
    manifest_version: 3,
    name: isDev ? "GitMon (Dev)" : "GitMon — Your Coding Pet",
    // 1.0.0 = first Chrome Web Store submission (2026-04-08). Bump
    // semver on every subsequent upload: patch for bug fixes, minor
    // for features without permission changes, major when
    // `permissions` or `host_permissions` change (triggers a
    // permission-warning banner on the store and forces all existing
    // users to re-accept). See SUBMISSION.md §9.
    version: "1.0.0",
    description: isDev
      ? "DEV BUILD — points at localhost:3000. Your coding pet, always with you."
      : "Your coding pet, always with you. Your GitMon floats beside you on GitHub and reacts to your activity.",
    icons: {
      16: isDev ? "icons/icon-16-dev.png" : "icons/icon-16.png",
      48: isDev ? "icons/icon-48-dev.png" : "icons/icon-48.png",
      128: isDev ? "icons/icon-128-dev.png" : "icons/icon-128.png",
    },
    action: {
      default_popup: "src/popup/index.html",
      default_title: isDev ? "GitMon (Dev)" : "GitMon",
      default_icon: {
        16: isDev ? "icons/icon-16-dev.png" : "icons/icon-16.png",
        48: isDev ? "icons/icon-48-dev.png" : "icons/icon-48.png",
        128: isDev ? "icons/icon-128-dev.png" : "icons/icon-128.png",
      },
    },
    background: {
      service_worker: "src/background/service-worker.ts",
      type: "module",
    },
    content_scripts: [
      {
        matches: ["https://github.com/*"],
        js: ["src/content/content-script.ts"],
        run_at: "document_idle",
      },
      {
        // Auth bridge content script — narrowly matches only the connect
        // page on the appropriate origin (localhost in dev, prod in prod).
        matches: [`${WEB_ORIGIN}/extension/connect*`],
        js: ["src/content/auth-bridge-content.ts"],
        run_at: "document_idle",
      },
    ],
    // Minimal permission surface — Chrome Web Store review rejects
    // unused permissions. `activeTab` was removed 2026-04-08: the
    // extension never calls any activeTab-gated API (all `chrome.tabs`
    // calls we make are either create/remove without URL inspection
    // or query/sendMessage covered by `host_permissions`).
    permissions: ["storage", "alarms", "idle"],
    host_permissions: [`${WEB_ORIGIN}/*`, "https://github.com/*"],
    options_page: "src/options/index.html",
  };
});
