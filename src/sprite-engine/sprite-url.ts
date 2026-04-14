/**
 * GitMon extension — sprite CDN URL builder.
 *
 * Sprites live at `${WEB_ORIGIN}/sprites/{species}/{stage}_idle.png`.
 * Sleeping uses the idle PNG + CSS overlay (Zzz floater + dimmer filter).
 * Walk sheets are 192×64 `{stage}_walk.png` (3 frames).
 *
 * Why not use the manifest.json: in the web app the manifest exists to
 * decide between PNG sprites and the procedural fallback. The extension
 * doesn't ship the procedural engine and doesn't bundle PNGs locally
 * (lazy CDN load with browser HTTP cache — see spec §2.5). So we don't
 * need a manifest fetch on every page load; the rules below are sufficient.
 */

import { STAGE_LABELS, type AnimationState } from "./state-machine";

/**
 * No species ships separate `_sleeping.png` sprites anymore — the W2
 * pipeline that produced them was retired. Sleeping is now a CSS overlay
 * effect (Zzz floater + dimmer filter on the idle sprite). The old
 * per-species exclusion set (`SPECIES_WITHOUT_SLEEPING`) is gone; the
 * `resolveSpriteVariant` function always returns "idle".
 */

/**
 * Species whose regeneration pipeline used `walkStyle: "none"` because
 * they are limbless (atom, slime) or serpentine (snake) — the skeleton
 * estimator can't animate them cleanly. These have NO `_walk.png`
 * sheet on the CDN; requesting one 404s and leaves the extension sprite
 * invisible. Keep in sync with `species-prompts.mjs` in the web app.
 */
const SPECIES_WITHOUT_WALK_SHEET = new Set(["atom", "slime", "snake"]);

/**
 * Species that only have adult-stage sprites on the CDN. All other stages
 * (egg, baby, teen) 404, so we force stage label to "adult" regardless of
 * the gitmon's actual evolution_stage. Currently only the dev-exclusive
 * neon_phantom — if more one-of-one species are added with partial sprite
 * sets, add them here.
 */
const SPECIES_ADULT_ONLY = new Set(["neon_phantom"]);

/**
 * Does the given species ship a walk spritesheet for non-egg stages?
 * The extension uses this to decide between the walk sheet (animated
 * via `steps(3)` CSS keyframes) and the static idle PNG.
 */
export function speciesHasWalkSheet(species: string): boolean {
  return !SPECIES_WITHOUT_WALK_SHEET.has(species);
}

export interface SpriteUrlInput {
  species: string;
  stage: number;
  state: AnimationState;
}

/**
 * Resolve which variant to render for the given animation state.
 * All states (including sleeping) use the idle PNG — visual treatment
 * is handled via CSS overlays (Zzz floater + dimmer filter).
 */
export function resolveSpriteVariant(
  _species: string,
  _state: AnimationState,
): "idle" {
  return "idle";
}

/**
 * Build the absolute CDN URL for a given species/stage/state. The web
 * origin is injected at build time (vite.config.ts → define) so dev and
 * prod hit the right host without code changes.
 */
export function buildSpriteUrl(input: SpriteUrlInput): string {
  const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;
  const stageLabel = SPECIES_ADULT_ONLY.has(input.species)
    ? "adult"
    : (STAGE_LABELS[input.stage] ?? "adult");
  const variant = resolveSpriteVariant(input.species, input.state);
  return `${WEB_ORIGIN}/sprites/${input.species}/${stageLabel}_${variant}.png`;
}

/**
 * Build the absolute CDN URL for the walk spritesheet of a given
 * species/stage. Used by the content script's drag + wander flow, which
 * renders the sprite as a CSS background-image + `steps(3)` animation on
 * the 192×64 sheet instead of the static idle PNG.
 *
 * Eggs have no walk sheet (they don't walk). The caller is expected to
 * only request walk URLs for baby / teen / adult stages — if called on
 * an egg we still return the path so the 404 surfaces loudly.
 */
export function buildWalkSheetUrl(input: {
  species: string;
  stage: number;
}): string {
  const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN as string;
  const stageLabel = SPECIES_ADULT_ONLY.has(input.species)
    ? "adult"
    : (STAGE_LABELS[input.stage] ?? "adult");
  return `${WEB_ORIGIN}/sprites/${input.species}/${stageLabel}_walk.png`;
}
