import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";
import { fileURLToPath, URL } from "node:url";

/**
 * Vite config for the GitMon browser extension.
 *
 * Uses @crxjs/vite-plugin for first-class Manifest V3 support: HMR during
 * development, automatic background/content-script bundling, asset copying,
 * and a single `manifest.json` source of truth that Vite reads directly.
 *
 * Output: `./dist/` — load this directory via
 * chrome://extensions → "Load unpacked". The dist folder is gitignored.
 *
 * We use a path alias `@ext/` for imports within the extension source, and
 * `@web/` for shared code from the Next.js app (notably the sprite engine).
 * The build-time copy of `src/lib/sprite-engine` happens via a pre-build
 * script (see `package.json` scripts) — we don't import straight across the
 * boundary so the extension remains self-contained and doesn't drag in the
 * Next.js build graph.
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === "development";
  // Must match `WEB_ORIGIN` in manifest.config.ts — Vite injects this
  // value into the runtime bundle via `import.meta.env.VITE_WEB_ORIGIN`,
  // the manifest uses the same literal for host_permissions + content
  // script matches. Single source of truth lives in BOTH files because
  // Vite config + manifest plugin run in separate contexts. When you
  // change one, change the other.
  const WEB_ORIGIN = isDev
    ? "http://localhost:3000"
    : "https://gitmon.io";

  return {
    root: __dirname,
    plugins: [react(), crx({ manifest })],
    resolve: {
      alias: {
        "@ext": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    // Inject WEB_ORIGIN as a build-time constant. The runtime TS files
    // read it via `import.meta.env.VITE_WEB_ORIGIN` and Vite replaces
    // the access with a string literal. This stays in sync with the
    // manifest.config.ts logic above (single source of truth: `mode`).
    define: {
      "import.meta.env.VITE_WEB_ORIGIN": JSON.stringify(WEB_ORIGIN),
    },
    build: {
      // Separate output dirs so dev and prod builds don't overwrite
      // each other. Load unpacked from `dist/` for prod, `dist-dev/`
      // for the dev variant.
      outDir: isDev ? "dist-dev" : "dist",
      emptyOutDir: true,
      sourcemap: true,
      // NOTE: @crxjs/vite-plugin automatically infers Rollup inputs from
      // manifest.config.ts (action.default_popup, background.service_worker,
      // content_scripts[].js, options_page). Manually declaring them here
      // causes "Could not resolve entry module" because the paths are
      // resolved relative to process.cwd() instead of the Vite `root`.
    },
    // Vite dev server — not strictly needed for extensions (you test via
    // chrome://extensions Load Unpacked) but crxjs uses it for HMR when
    // running `npm run dev`.
    server: {
      port: 5179,
      strictPort: true,
      hmr: {
        port: 5180,
      },
    },
  };
});
