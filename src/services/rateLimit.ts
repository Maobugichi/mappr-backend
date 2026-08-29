import { pool } from '../db/pool.js';

export const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT ?? 2);
export const GLOBAL_DAILY_CEILING = Number(process.env.GLOBAL_DAILY_CEILING ?? 200);

export async function generationsToday(anonId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM generations
     WHERE anon_id = $1 AND created_at >= date_trunc('day', now())`,
    [anonId]
  );
  return rows[0].count;
}

export async function totalGenerationsToday(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM generations
     WHERE created_at >= date_trunc('day', now())`
  );
  return rows[0].count;
}

export type RateLimitCheck =
  | { allowed: true }
  | { allowed: false; reason: 'user_limit' | 'global_limit' };


export async function checkRateLimits(anonId: string): Promise<RateLimitCheck> {
  const [userCount, globalCount] = await Promise.all([
    generationsToday(anonId),
    totalGenerationsToday(),
  ]);

  if (globalCount >= GLOBAL_DAILY_CEILING) {
    return { allowed: false, reason: 'global_limit' };
  }

  if (userCount >= FREE_DAILY_LIMIT) {
    return { allowed: false, reason: 'user_limit' };
  }

  return { allowed: true };
}