// Demo organizations (is_locked = 'N'): deleted by arcanum-cleaner once
// they're DEMO_LIFETIME_HOURS old. Dependency-free on purpose — used by
// organizations.ts (the `demo` field of every organization JSON) and by
// demo-orgs.ts (the internal endpoint that creates them), which itself
// depends on modules that depend on organizations.ts.
import type { Env } from '../env';

const DEFAULT_LIFETIME_HOURS = 4;
const DEFAULT_MAX_LIVE = 20;

export function demoLifetimeHours(env: Env): number {
  const hours = Number(env.DEMO_LIFETIME_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LIFETIME_HOURS;
}

export function demoMaxLive(env: Env): number {
  const max = Number(env.DEMO_MAX_LIVE);
  return Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX_LIVE;
}

export function demoExpiresAt(env: Env, createdAt: string): string {
  return new Date(Date.parse(createdAt) + demoLifetimeHours(env) * 3600_000).toISOString();
}

// The console's demo banner ("verdwijnt om 16:30 · Eigen installatie →").
// Null for every org the cleaner leaves alone (is_locked anything but 'N').
export function demoInfo(env: Env, row: { is_locked: string | null; created_at: string }): { expiresAt: string; installUrl: string | null } | null {
  if (row.is_locked !== 'N') return null;
  return { expiresAt: demoExpiresAt(env, row.created_at), installUrl: env.DEMO_INSTALL_URL?.trim() || null };
}
