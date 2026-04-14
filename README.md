# GitMon — Chrome Extension

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-green.svg)](./LICENSE)

Your coding pet, always with you. A tiny creature that floats beside you on github.com, reacts to your activity, and comments in-character using an LLM of your choice.

This repo contains the **public source code of the GitMon browser extension**. The main web application lives in a separate (closed) repository — this repo is fully self-contained and auditable.

## Install

### Option A — Chrome Web Store (recommended)
Coming soon. Link will appear here once store review completes.

### Option B — Load unpacked (dev mode, any Chromium browser)
For developers, reviewers, or users who want to audit before installing.

**Requirements:** Node 20+ and npm.

```bash
git clone https://github.com/brunobracaioli/gitmon-extension.git
cd gitmon-extension
npm install
npm run icons      # one-time: generates placeholder PNG icons
npm run build      # → dist/
```

Then in Chrome / Edge / Brave / Arc:
1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. A purple **G** icon appears in the toolbar

**Pair with your account** (required — nothing appears on github.com until this is done):
1. Click the purple **G** icon in the toolbar to open the popup
2. Click **Connect** — a new tab opens at [gitmon.io](https://gitmon.io)
3. Sign in with GitHub (if you aren't already) — you'll return to `/extension/connect` automatically
4. The page posts a one-time token back to the extension and auto-closes
5. Visit any page on `github.com` — your gitmon should appear at the bottom-right

Credentials never live in the extension source; only the short-lived OTT crosses over.

### Hot-reload during development
If you're modifying the extension source, skip `build` and use Vite's dev mode:

```bash
npm run dev        # watches src/ and rewrites dist-dev/ on save
```

Load `dist-dev/` via "Load unpacked" (it ships with an **orange** G icon and talks to `http://localhost:3000` instead of `gitmon.io`, so prod and dev can coexist side-by-side — see [Two builds](#two-builds-dev-vs-prod) below).

## How it works

- Injects a single `<div id="gitmon-root">` on `github.com/*` under a **closed Shadow DOM** — page CSS / JS cannot touch what we render.
- A service-worker alarm polls `https://gitmon.io/api/v1/public/gitmon/{username}` every 60s for current vitals, evolution stage, and status.
- Sprite PNGs lazy-load from the gitmon.io CDN (never bundled).
- Every 60–180s the creature fires a speech bubble. If you configured an LLM API key (Anthropic or OpenAI) on your gitmon.io dashboard, the call goes **directly from your browser to the LLM provider** using your own key. Bubble text never touches our backend. Without a key, scripted fallback phrases are used.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist auth token + cached gitmon state in `chrome.storage.local`. |
| `alarms` | One background alarm per minute for state sync (battery-friendly vs. `setInterval` in every tab). |
| `idle` | Pause the 60s poll while the machine is idle. |
| `host_permissions: https://gitmon.io/*` | Pull your gitmon state + AI config from our API. |
| `host_permissions: https://github.com/*` | Inject the sprite on github.com (the only site we touch). |

No `<all_urls>`. No `activeTab`. No `scripting` API. No third-party analytics. See [`SUBMISSION.md`](./SUBMISSION.md) for the full Chrome Web Store permission justifications.

## Privacy

- The extension never reads, transmits, or indexes source code.
- The only outbound network calls are (a) `https://gitmon.io/*` for your own gitmon state, (b) `https://api.anthropic.com` or `https://api.openai.com` directly from your browser using a key you provided, to generate speech bubble text.
- Full policy: [`https://gitmon.io/privacy`](https://gitmon.io/privacy).

## Two builds: Dev vs Prod

The extension ships as two visually-distinct variants so you can load dev (localhost) and prod (gitmon.io) side-by-side without swapping:

```bash
npm run build       # → dist/      (prod, purple G, https://gitmon.io)
npm run build:dev   # → dist-dev/  (dev, orange G, http://localhost:3000)
```

Chrome assigns different extension IDs, so `chrome.storage.local` is isolated between them.

## Structure

```
.
├── manifest.config.ts     # Dynamic MV3 manifest (dev/prod branch)
├── vite.config.ts         # Vite + @crxjs/vite-plugin
├── tsconfig.json
├── public/icons/          # Placeholder icons (generated via npm run icons)
├── scripts/
│   └── make-placeholder-icons.mjs
├── src/
│   ├── background/        # Service worker (state poll, AI config pull, alarms)
│   ├── content/           # github.com content script (sprite, drag, wander, speech)
│   ├── lib/               # LLM client, prompt builder, state store, auth bridge
│   ├── sprite-engine/     # Sprite state machine + CDN URL builder
│   ├── popup/             # Toolbar popup UI
│   └── options/           # Options page
└── SUBMISSION.md          # Chrome Web Store submission playbook
```

## Contributing

Issues and PRs welcome. Scope is intentionally narrow — backend behavior (state endpoint, AI config endpoint, auth handoff) lives in the closed gitmon.io web app and is out of scope here.

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE).
