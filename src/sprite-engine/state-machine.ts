/**
 * GitMon extension — animation state resolver.
 *
 * PORTED from `src/lib/sprite-engine/state-machine.ts` in the web app.
 * Kept as a separate file (instead of imported across the boundary) so the
 * extension build is self-contained — no dependency on the Next.js
 * `tsconfig.json` `paths`, no risk of dragging in React or server-only code.
 *
 * Source-of-truth divergence rule: if the web's resolver changes (new
 * status, new threshold), MIRROR the change here. The two are intentionally
 * a copy-paste pair, not a runtime import.
 */

export type AnimationState =
  | "idle"
  | "happy"
  | "hungry"
  | "critical"
  | "sleeping"
  | "dead"
  | "hatching"
  | "eating"
  // User-driven (drag / autonomous wander). `resolveAnimationState` NEVER
  // returns this — it's set imperatively by the content script and reverts
  // to the resolver's output when the wander loop stops.
  | "walking";

export interface GitMonState {
  status: string;
  hunger: number;
  happiness: number;
  energy: number;
  level: number;
  evolution_stage: number;
  hatch_progress: number;
  last_activity_at?: string | null;
}

/** Hours of inactivity before gitmon falls asleep — must match server `decay.ts`. */
const SLEEP_THRESHOLD_HOURS = 48;

export function resolveAnimationState(gitmon: GitMonState): AnimationState {
  if (gitmon.status === "dead") return "dead";
  if (gitmon.status === "egg") return "idle";
  if (gitmon.status === "hatching") return "hatching";
  if (gitmon.status === "critical" || gitmon.hunger <= 10) return "critical";
  if (gitmon.status === "hungry" || gitmon.hunger < 30) return "hungry";

  if (gitmon.last_activity_at) {
    const hoursSince =
      (Date.now() - new Date(gitmon.last_activity_at).getTime()) /
      (1000 * 60 * 60);
    if (hoursSince >= SLEEP_THRESHOLD_HOURS) return "sleeping";
  }

  if (gitmon.happiness > 80) return "happy";
  return "idle";
}

/** Stage number → folder slug. Mirrors the web app's STAGE_LABELS. */
export const STAGE_LABELS: Record<number, string> = {
  0: "egg",
  1: "baby",
  2: "teen",
  3: "adult",
};
