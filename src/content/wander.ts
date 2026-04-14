/**
 * Autonomous wander loop for the companion sprite.
 *
 * Invoked from `content-script.ts` after the user finishes dragging the
 * sprite: the sprite keeps walking to random points inside the viewport
 * for a few seconds, then stops wherever it ended up. One single RAF
 * driver lives at a time — `startWander()` cancels any previous loop.
 *
 * Position model: the sprite's wrap is anchored via CSS `right` +
 * `bottom`, not `left` + `top`, because that's how the existing drag
 * code positions it. We convert between top-left px (internal, easy to
 * clamp) and right/bottom px (external, applied to the DOM) each tick.
 *
 * The wander loop does NOT write `data-state` back to its resolver
 * value on finish. It sets `data-state="walking"` on start and restores
 * the last resolved state via `resolveIdle()` on stop. Content script
 * is the only module that knows the current snapshot.
 */

import type { AnimationState } from "../sprite-engine";

const SPEED_PX_PER_SEC = 40;
const ARRIVE_DIST_PX = 2;
const STALL_MS = 600;
const MIN_DURATION_MS = 4000;
const MAX_DURATION_MS = 8000;
const SPRITE_BOX = 96; // matches .gm-wrap width/height
const EDGE_PAD_PX = 8;

interface WanderCtx {
  wrap: HTMLElement;
  label: HTMLElement;
  resolveIdle: () => AnimationState;
  /**
   * Fired after the wander loop stops and data-state has been restored
   * to the resolver's idle value. Lets the caller swap the sprite back
   * to the static `_idle.png` (vs. the 3-frame walk sheet used while
   * moving).
   */
  onStop?: () => void;
}

interface ActiveWander {
  ctx: WanderCtx;
  rafId: number | null;
  // Internal top-left px coordinates.
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  lastProgressAt: number;
  lastProgressDist: number;
  startedAt: number;
  durationMs: number;
  lastTickAt: number;
}

let active: ActiveWander | null = null;

export function isWandering(): boolean {
  return active !== null;
}

/**
 * Begin autonomous wander. If one is already running it is cancelled
 * first. The sprite's current position is read from the DOM once; from
 * then on every tick writes back right/bottom.
 */
export function startWander(ctx: WanderCtx): void {
  stopWander();

  const rect = ctx.wrap.getBoundingClientRect();
  const x = clamp(rect.left, EDGE_PAD_PX, window.innerWidth - SPRITE_BOX - EDGE_PAD_PX);
  const y = clamp(rect.top, EDGE_PAD_PX, window.innerHeight - SPRITE_BOX - EDGE_PAD_PX);

  active = {
    ctx,
    rafId: null,
    x,
    y,
    targetX: x,
    targetY: y,
    lastProgressAt: performance.now(),
    lastProgressDist: 0,
    startedAt: performance.now(),
    durationMs: randRange(MIN_DURATION_MS, MAX_DURATION_MS),
    lastTickAt: performance.now(),
  };

  pickNewTarget(active);
  writePosition(active);
  ctx.wrap.dataset.state = "walking";

  active.rafId = requestAnimationFrame(tick);
}

/**
 * Cancel the wander loop and restore the resolver's idle state. Safe to
 * call when no wander is active (idempotent).
 */
export function stopWander(): void {
  if (!active) return;
  const { ctx } = active;
  if (active.rafId !== null) cancelAnimationFrame(active.rafId);
  const idle = ctx.resolveIdle();
  ctx.wrap.dataset.state = idle;
  active = null;
  // Fire callback AFTER active is cleared so the caller's isWandering()
  // check resolves to false inside the callback.
  ctx.onStop?.();
}

function tick(now: number): void {
  if (!active) return;
  const a = active;
  const dt = Math.min((now - a.lastTickAt) / 1000, 0.05); // cap dt to avoid huge jumps on tab focus
  a.lastTickAt = now;

  // Total duration exceeded → stop gracefully at current position.
  if (now - a.startedAt >= a.durationMs) {
    stopWander();
    return;
  }

  const dx = a.targetX - a.x;
  const dy = a.targetY - a.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= ARRIVE_DIST_PX) {
    pickNewTarget(a);
  } else {
    // Stall detection: if the sprite hasn't made meaningful progress in
    // STALL_MS (e.g. window resized so target is off-screen), reroute.
    if (a.lastProgressDist - dist < 0.5) {
      if (now - a.lastProgressAt > STALL_MS) {
        pickNewTarget(a);
      }
    } else {
      a.lastProgressAt = now;
      a.lastProgressDist = dist;
    }

    const step = Math.min(SPEED_PX_PER_SEC * dt, dist);
    a.x += (dx / dist) * step;
    a.y += (dy / dist) * step;

    // Update facing based on X velocity sign. Sprites are drawn facing
    // east (+X) so negative dx → flip.
    if (dx < -0.1) a.ctx.wrap.dataset.facing = "L";
    else if (dx > 0.1) a.ctx.wrap.dataset.facing = "R";
  }

  writePosition(a);
  a.rafId = requestAnimationFrame(tick);
}

function pickNewTarget(a: ActiveWander): void {
  const minX = EDGE_PAD_PX;
  const maxX = Math.max(minX + 1, window.innerWidth - SPRITE_BOX - EDGE_PAD_PX);
  const minY = EDGE_PAD_PX;
  const maxY = Math.max(minY + 1, window.innerHeight - SPRITE_BOX - EDGE_PAD_PX);
  a.targetX = randRange(minX, maxX);
  a.targetY = randRange(minY, maxY);
  a.lastProgressAt = performance.now();
  a.lastProgressDist = Math.hypot(a.targetX - a.x, a.targetY - a.y);
}

/**
 * Convert internal top-left px to the wrap's CSS right/bottom anchors,
 * and keep the floating label glued 32px above the sprite.
 */
function writePosition(a: ActiveWander): void {
  const right = Math.max(4, window.innerWidth - a.x - SPRITE_BOX);
  const bottom = Math.max(4, window.innerHeight - a.y - SPRITE_BOX);
  a.ctx.wrap.style.right = `${right}px`;
  a.ctx.wrap.style.bottom = `${bottom}px`;
  a.ctx.label.style.right = `${right - 4}px`;
  a.ctx.label.style.bottom = `${bottom + SPRITE_BOX}px`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
