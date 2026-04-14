# Chrome Web Store Submission Guide

End-to-end playbook for shipping the GitMon extension to the Chrome Web
Store. Written as a checklist — work top-to-bottom and don't skip the
review-prep sections, they're where rejections come from.

All of the text under "Store listing content" and "Privacy practices"
below was drafted specifically for GitMon's permission set and data
flow. Paste it verbatim into the Developer Dashboard forms; if you
diverge, re-read the Chrome Web Store program policies first
(<https://developer.chrome.com/docs/webstore/program-policies>).

---

## 0. Pre-flight checklist (do before opening the Dashboard)

Work through this list in a single sitting. Every item that fails is a
rejection risk.

**Manifest**
- [ ] `manifest.config.ts` → `version` bumped from `0.1.0` to a
      public-ready number (suggested: `1.0.0` for the initial submission;
      Chrome requires monotonically increasing versions on every update).
- [ ] `name` in prod mode reads "GitMon — Your Coding Pet" (or whatever
      marketing lands on — must be ≤ 45 chars and not contain "Google",
      "Chrome", or "Extension").
- [ ] `description` in prod mode is ≤ 132 chars and does not repeat the
      name verbatim.
- [ ] `permissions` contains ONLY what the code actually calls. Currently
      `["storage", "alarms"]`. `activeTab` was removed 2026-04-08 —
      unused permissions are a classic rejection trigger.
- [ ] `host_permissions` is minimal: `${WEB_ORIGIN}/*` +
      `https://github.com/*`. Do NOT ship `<all_urls>` or any broader
      pattern without a killer justification — this is the single
      biggest friction point on review.
- [ ] No `"content_security_policy"` override in the manifest (we don't
      need one — default MV3 CSP is fine).

**Build artifacts**
- [ ] `npm run typecheck` clean.
- [ ] `npm run build` (production mode, outputs `dist/`)
      completes with no warnings.
- [ ] `dist/manifest.json` contains the prod name, description,
      icons, host permissions (NOT localhost, NOT `dist-dev` variants).
- [ ] `dist/` does NOT contain any `.map` files referencing
      localhost paths or source that would leak. (Vite writes `.map`
      files in prod too — fine to ship, they only carry source text.)
- [ ] Smoke-test the prod build: `chrome://extensions` → "Load unpacked"
      → point at `dist/` → visit github.com → sprite renders,
      drag-to-walk works, mini-popup opens, Dashboard/World/Back-to-corner
      buttons work, periodic bubble fires within a few minutes.

**Icons**
- [ ] `public/icons/` has `icon-16.png`, `icon-48.png`,
      `icon-128.png` for prod (purple) variants — NOT the `-dev` ones.
      The placeholder generator is at
      `scripts/make-placeholder-icons.mjs` but the store
      requires higher-quality icons than the placeholders. Replace with
      a hand-drawn or AI-generated set before submission. The 128×128
      icon is what shows on the store listing card — put your best art
      there.

**Backend**
- [ ] `https://gitmon.io/privacy` is live and up-to-date
      (Phase X1.1 — refresh the M&A clause if it changed since
      2026-04-07).
- [ ] `https://gitmon.io/terms` is live.
- [ ] `https://gitmon.io/security` is live (X1.4).
- [ ] `https://gitmon.io/extension/connect` works end-to-end
      against the prod extension (do an OTT handoff from the real
      `dist/` build, not `dist-dev/`).
- [ ] `POST /api/extension/handoff`, `POST /api/extension/exchange`,
      `GET /api/extension/ai-config`, `GET /api/v1/public/gitmon/{username}`
      all respond 200 in prod.
- [ ] `bruno@b2tech.io` is monitored — Chrome Web Store reviewers email
      this address on rejection or questions.

**Legal**
- [ ] Privacy policy URL ready to paste: `https://gitmon.io/privacy`
- [ ] The privacy policy explicitly mentions the extension and what it
      stores (session token, cached gitmon state, cached AI config).
      If it doesn't, add a section before submitting — Chrome reviewers
      grep for keywords here.

---

## 1. One-time developer account setup

Skip this section if you already have a publisher account.

1. Sign into Chrome with the Google account you want to publish under.
   **This is important — you cannot transfer extensions between
   accounts later without a manual CWS support ticket.** Use a
   durable, stable Google account (not a personal school/alumni one).
2. Go to <https://chrome.google.com/webstore/devconsole>.
3. Pay the **one-time $5 USD** developer registration fee. Requires
   a credit card. This unlocks publishing up to 20 items.
4. (Optional but recommended) Create a **group publisher** from the
   Account page if GitMon is owned by B2 Tech Ltda as a legal entity —
   lets you list "B2 Tech" as the developer name instead of your
   personal name. Requires domain verification of `b2tech.io` via
   Google Search Console or a TXT DNS record.
5. Complete the **account verification** (phone + email) — extensions
   stay in "Pending verification" limbo otherwise.

---

## 2. Package the build

From the repo root:

```bash
# 1. Build prod (outputs dist/)
npm run build

# 2. Zip it. If you have the `zip` CLI installed:
cd dist
zip -r ../gitmon-extension-v1.0.0.zip . -x "*.map" "*-dev.png"
cd ..

# 2-alt. WSL / systems without `zip` — use Python 3:
python3 -c "
import os, zipfile
with zipfile.ZipFile('gitmon-extension-v1.0.0.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk('dist'):
        for f in files:
            if f.endswith('.map'): continue
            if '-dev.png' in f: continue
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, 'dist'))
"
```

**Notes:**
- Zip from **inside** `dist/`, not the repo root. The manifest
  must be at the zip root, not nested under a `dist/` folder — Chrome
  rejects "manifest.json not found at top level" uploads.
- The `*.map` exclusion strips source maps. Store listing upload cap is
  generous (hundreds of MB) so they'd fit, but stripping them hides the
  unminified source from anyone who downloads the .crx and means
  smaller download for users. Keep the maps locally for debugging.
- The `*-dev.png` exclusion strips the dev variant icons (`icon-16-dev.png`,
  `icon-48-dev.png`, `icon-128-dev.png`) that Vite copies from
  `public/icons/` into every build. They're unused in prod but confuse
  reviewers who glance at zip contents and see "DEV" branding.
- Sanity-check the zip: `unzip -l gitmon-extension-v1.0.0.zip` (or
  `python3 -c "import zipfile; print(zipfile.ZipFile('...').namelist())"`).
  Expected: ~18 files, **`manifest.json` first**, NO `.map`, NO `-dev`.
- The `.zip` artifact is gitignored (`*.zip`).

---

## 3. Open the Dashboard and create a new item

1. <https://chrome.google.com/webstore/devconsole> → "Add new item".
2. Upload the `.zip` from §2.
3. Chrome auto-parses the manifest and pre-fills the name, description,
   version, and icon. If any of those look wrong, stop, fix the manifest
   config, rebuild, rezip, and re-upload.

You now land on the **Store listing** tab. Work through every tab on
the left (Store listing → Privacy practices → Distribution) before
hitting "Submit for review".

---

## 4. Store listing content (paste-ready)

Fill each field below. Values in `code` fences are drafts — tweak wording
but keep the structural shape (reviewers scan for specific concepts).

### 4.1 Product details

**Extension name** (≤ 45 chars)
```
GitMon — Your Coding Pet
```

**Summary / short description** (≤ 132 chars)
```
Your GitMon pet floats beside you on GitHub. Feed it by coding — it reacts, walks, and cheers you on as you browse repos.
```

**Detailed description** (≤ 16 000 chars, markdown-lite supported)
```
GitMon turns your GitHub activity into a virtual pet that lives in the
corner of your browser. Commit code, open pull requests, and review
issues to feed it and watch it evolve through four life stages.

What the extension does
• Shows your GitMon on github.com pages as a small pixel-art companion.
• Reacts in real time to your vitals — hunger, happiness, and energy —
  pulled from the GitMon backend every minute.
• Drag it anywhere on the page and it will walk back around for a few
  seconds before settling.
• Every minute or two it comments in a pixel speech bubble about its
  species, the repo you're viewing, or whatever it feels like. Powered
  by YOUR own Anthropic or OpenAI key — the key never reaches our
  backend beyond the secure authenticated endpoint you configure on the
  dashboard.
• Click the sprite to open a mini-popup with level, status, vitals
  bars, a Dashboard link, a World link, and a "Back to corner" button.
• A "Show on GitHub" toggle in the toolbar popup lets you hide the
  companion on any page.

What it does NOT do
• Does NOT read your GitHub code, pull requests, or issues.
• Does NOT track your browsing history, scroll position, or clicks.
• Does NOT send any data from github.com back to the GitMon servers —
  the only outbound traffic is to the GitMon API to fetch your pet's
  state.
• Does NOT run on any site other than github.com.

How to connect
1. Install the extension.
2. Click the GitMon icon in your toolbar → "Connect to GitMon".
3. A secure one-time-token handoff links the extension to your GitMon
   account (already signed in via GitHub on gitmon.io).
4. Start coding — your pet will react within the minute.

Learn more at https://gitmon.io
Privacy: https://gitmon.io/privacy
Terms: https://gitmon.io/terms
Security: https://gitmon.io/security
Contact: bruno@b2tech.io
```

**Category**: `Fun` (primary). Secondary if prompted: `Developer Tools`.

**Language**: `English (United States)`. You can add more later.

### 4.2 Graphic assets

All images must be PNG, no transparency on the promotional tiles.

| Asset | Required? | Spec | Suggested content |
|---|---|---|---|
| **Store icon** | ✅ | 128×128 PNG | The purple G icon at full resolution (hand-drawn, NOT the placeholder) |
| **Screenshot 1** | ✅ (at least 1) | 1280×800 or 640×400 | Sprite on a real GitHub repo page (e.g. viewing `vercel/next.js`), mini-popup open showing vitals |
| **Screenshot 2** | recommended | 1280×800 | Walk animation mid-drag, showing the sprite flipped and walking |
| **Screenshot 3** | recommended | 1280×800 | Speech bubble visible with an AI-generated line |
| **Screenshot 4** | recommended | 1280×800 | Toolbar popup with "Connected as @username" + toggle + Disconnect |
| **Small promo tile** | recommended | 440×280 PNG | Sprite + "Your Coding Pet" tagline — this shows on the store search results |
| **Marquee promo tile** | optional | 1400×560 PNG | Featured placement only — skip for first submission |

Capture screenshots via Chrome's built-in DevTools → Device Mode at
1280×800 viewport so they're pixel-perfect without scaling. Do NOT
include your real GitHub avatar/username in the screenshots unless
you're OK with that being public — or use a throwaway test account.

### 4.3 Additional fields

**Official URL**: `https://gitmon.io`
**Homepage URL**: `https://gitmon.io`
**Support URL**: `https://gitmon.io/security` (reachable contact)
**Mature content**: No

---

## 5. Privacy practices (the part that gets extensions rejected)

This is on the **Privacy practices** tab. Be exhaustive — lies here
cause hard rejections and possible permanent bans.

### 5.1 Single purpose description

Required field. Must be one concise sentence describing what the
extension does.

```
GitMon displays a virtual pet (GitMon) on github.com pages that reflects the user's coding activity, with drag-to-walk interaction, a mini-popup showing pet vitals and quick links to the GitMon dashboard, and periodic AI-generated speech bubbles powered by the user's own LLM API key.
```

### 5.2 Permission justifications

For EACH permission listed in the manifest, Chrome will ask for a
justification. Paste these verbatim.

**`storage`**
```
Required to persist the extension session token (so the user does not have to re-authenticate on every browser restart), the last-known GitMon state snapshot (so the sprite can render immediately when a github.com page loads without waiting for a network round trip), the user's AI personality configuration (traits + LLM API key, fetched from an authenticated GitMon backend endpoint), and the user's display preferences (enable/disable toggle). All values are stored in chrome.storage.local (authentication) and chrome.storage.sync (display preferences). No data from the user's browsing activity is stored.
```

**`alarms`**
```
Required to schedule two periodic background syncs from a single service worker: a 60-second state pull that fetches the current GitMon vitals from the GitMon API, and a 6-hour AI config refresh that fetches the user's LLM personality settings. Using a single alarm means exactly one API call per minute regardless of how many GitHub tabs the user has open, which is critical for both rate-limit hygiene and battery life. Without alarms, the alternative would be a setInterval inside every open GitHub tab's content script, which would N-multiply the API load.
```

### 5.3 Host permission justifications

**`https://github.com/*`**
```
Required to inject the GitMon companion sprite onto GitHub.com pages via a closed Shadow DOM overlay. The sprite is a fixed-position decorative element that does NOT read the page's cookies, localStorage, DOM contents, form inputs, private-repo contents, or any other GitHub data. The only page-level information the extension reads is window.location.pathname, which it parses locally to identify which public repository the user is viewing (e.g. "vercel/next.js") so that the periodic AI-generated speech bubbles can reference the repo by name. This pathname is never transmitted to the GitMon backend — it is only used as context for the user's own LLM API call, which goes directly from the browser to the user's chosen provider (Anthropic or OpenAI).
```

**`https://gitmon.io/*`**
```
Required for the extension to communicate with the GitMon backend. The extension calls four authenticated endpoints: POST /api/extension/handoff (one-time token generation), POST /api/extension/exchange (OTT → session token swap), GET /api/v1/public/gitmon/{username} (public GitMon state polling, once per minute), and GET /api/extension/ai-config (authenticated fetch of the user's LLM personality config, once every six hours). No data collected from github.com pages ever flows to this origin — the extension only reads from the GitMon backend, never writes user browsing data to it.
```

### 5.4 Data disclosure (required form)

Chrome presents a grid of data types. Answer as follows:

| Data type | Collected? | Notes |
|---|---|---|
| Personally identifiable information | ✅ Yes | The user's GitHub username (cached from the linked GitMon account for display in the popup) |
| Health information | ❌ No | |
| Financial and payment information | ❌ No | |
| Authentication information | ✅ Yes | Extension session token (64-char hex, 30-day TTL) generated by the GitMon backend during the OAuth handoff flow. Stored in chrome.storage.local. Never transmitted to anyone except the GitMon backend. |
| Personal communications | ❌ No | |
| Location | ❌ No | |
| Web history | ❌ No | |
| User activity | ❌ No | The extension does NOT record scroll, clicks, time on page, or any interaction with github.com. The current repo name (owner/name) is read from window.location.pathname only at the moment a speech bubble fires, and is used solely as context for the user's own LLM call. |
| Website content | ❌ No | The extension does not read the DOM of github.com pages. |

**Data usage certification** (three checkboxes, check all three):
- [x] I do not sell or transfer user data to third parties, apart from the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**: `https://gitmon.io/privacy`

---

## 6. Distribution

**Visibility**: `Public` (the default) OR `Unlisted` for a soft launch.

Strongly consider `Unlisted` for the first review round:
- Store listing is hidden from search and featured lists.
- Direct install URL still works (you can share it with beta users).
- Reviewers treat unlisted items the same way, so you still validate
  the manifest + privacy form.
- You can flip to `Public` any time after approval without a new review.

**Distribution regions**: `All regions` unless you have a reason to
exclude markets (GDPR/CCPA compliance is handled at the privacy-policy
level, not the store level).

**Pricing**: `Free`. Monetization is deferred to Phase 7c via in-app
subscription (GitMon Plus, handled by the backend via LemonSqueezy or
Stripe), NOT via paid extension listings — Chrome's own payment rails
take a 5% cut and lock you in.

---

## 7. Submit for review

Hit **Submit for review** at the top of the page. You'll get a modal
asking you to re-confirm the data disclosures — read it once more, then
submit.

**What happens next:**
- Chrome sends a confirmation email to your publisher account email.
- The item moves to status `Pending review`.
- Typical turnaround: **1–3 business days** for a simple extension
  with clean permissions. First submissions are sometimes slower
  (up to 7 days) because automated + human review both kick in.
- On approval: the email says `Published` and the item becomes
  installable from the store URL listed in your dashboard.
- On rejection: the email says `Rejected` with a free-text reason
  field. Common reasons and fixes are in §8.

**While waiting**, do NOT re-upload a new zip — that cancels the review
and sends you back to the queue. Only re-upload if you got a
rejection and need to fix something.

---

## 8. Common rejection reasons (and how to avoid them)

Learned through the school of hard knocks — grouped by frequency for
GitMon-shaped extensions.

| Rejection code | What it means | Fix |
|---|---|---|
| **Purple** (missing or inadequate privacy policy) | The URL in the Privacy policy field is broken, blank, or doesn't mention the extension by name and what it stores. | Make sure `/privacy` is reachable and has a section titled something like "Browser Extension" that lists the stored session token, cached state, AI config. Chrome reviewers literally search for "extension" on the page. |
| **Blue** (single purpose violation) | The extension does "too many" things, or the single-purpose statement doesn't match what the code actually does. | Keep the single-purpose statement tightly focused on "virtual pet on GitHub that reflects user's coding activity". If the actual feature set drifts, update the statement first. |
| **Yellow** (permissions broader than needed) | You requested `<all_urls>`, `tabs`, or `scripting` without a justification, or a permission that the code doesn't actually call. | Strip unused permissions (we already removed `activeTab`). Keep host permissions explicit. |
| **Red** (metadata doesn't match functionality) | Screenshots show features the extension doesn't actually have, or the name implies something different from what it does. | Take screenshots of the REAL extension, not mockups. Don't use AI-generated screenshots that show imaginary features. |
| **Violet** (obfuscated code) | Minified bundles where the reviewer can't tell what the code does. Less common for modern Vite bundles. | Ship source maps, OR include a "How to review this code" section in the store listing that points to the public GitHub repo (once GitMon goes public). |
| **Green** (data disclosure mismatch) | You said you don't collect user activity but the code contains a listener that looks like analytics. | PostHog pageview events fire on the GitMon web app, not in the extension — the extension has no analytics at all today. Confirm this before submitting. Re-grep the extension source for `posthog` and `analytics` to double-check. |

If you get a rejection:
1. **Read the full rejection email carefully.** The reviewer notes are
   usually specific ("permission X not justified" / "privacy policy
   missing section Y").
2. Fix the specific issue. Do NOT rewrite everything defensively — the
   reviewer only cares about the flagged item.
3. Bump `version` in `manifest.config.ts` (any reupload requires a new
   version number, even for metadata-only changes — otherwise Chrome
   rejects the upload).
4. Rebuild, rezip, re-upload, re-submit.
5. Second-round reviews are usually faster (same day).

---

## 9. Post-approval

Once the extension is approved and published:

1. The public store URL is `https://chromewebstore.google.com/detail/{extension-id}`.
   Grab the `{extension-id}` — you need it for a few things:
   - Update `src/lib/auth-bridge.ts` if any code pattern
     matches against the extension ID (today it does not, but future
     cross-origin features may need it).
   - Update `extension_sessions.user_agent` allowlist if you ever add
     server-side ID verification (not implemented today).
   - Add the store URL to the GitMon landing page "Install extension"
     CTA.
2. **Smoke test from the store**: uninstall the unpacked dev build,
   install from the store URL, walk through the connect flow, verify
   the sprite renders and the speech bubble fires. If the prod build
   breaks in a way the dev build didn't, it's almost always a
   `WEB_ORIGIN` mismatch or a `host_permissions` that was missing in
   prod mode — check `dist/manifest.json`.
3. **Announce**: tweet, post on r/SideProject, DM early users. The
   moment the store listing goes live is the best marketing window.
4. **Monitor**: the Developer Dashboard has a "User feedback" tab that
   surfaces 1-star reviews within hours. Respond to critical ones
   (but never argue — thank + fix).

### Publishing updates

Every new feature or bug fix ships as a new version:
1. Bump `version` in `manifest.config.ts` (e.g. `1.0.0` → `1.0.1`).
2. `npm run build` → new `dist/`.
3. Zip + upload to the **same item** in the Developer Dashboard
   ("Upload new package" button). Do NOT create a new item — that's a
   fresh review and fresh store URL.
4. Fill in the changelog (visible to users in the store listing).
5. Submit for review. Update reviews are typically 24–48 hours.

Version bump rules:
- **Patch (1.0.X)**: bug fix, copy change, icon tweak.
- **Minor (1.X.0)**: new feature that doesn't change permissions.
- **Major (X.0.0)**: breaking change, new permissions, new
  `host_permissions`. New permissions trigger a **"permission warning"
  banner** on the store listing until all users re-accept — budget for
  user churn on major version bumps.

### Hotfix timeline

If a user reports a critical bug (e.g. sprite invisible on 100% of
repos for species X, or a crash in the content script):
1. Fix in `main`.
2. Bump patch version.
3. Submit update.
4. **Expect 24–48 hours** for the update to land — there is NO way to
   ship a hotfix faster than Google's review pipeline. Plan for this
   when scoping migrations: never push a backend change that depends
   on an extension update being live within the same hour.

---

## 10. Related reading

- Chrome Web Store policies: <https://developer.chrome.com/docs/webstore/program-policies>
- Manifest V3 reference: <https://developer.chrome.com/docs/extensions/mv3/>
- User data policy (the one that gets most extensions): <https://developer.chrome.com/docs/webstore/user-data>
- GitMon extension internal spec and phase tracker live in the closed
  gitmon.io web app repo (not public). This repo is the minimal,
  self-contained public mirror of the extension source intended for
  Chrome Web Store review and third-party audit.
