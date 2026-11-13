import { pool } from '../db/pool.js';
import type { PoolClient } from 'pg';

export const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT ?? 2);
export const GLOBAL_DAILY_CEILING = Number(process.env.GLOBAL_DAILY_CEILING ?? 200);

export async function generationsToday(anonId: string, database: Pick<PoolClient, 'query'> = pool): Promise<number> {
  const { rows } = await database.query(
    `SELECT count(*)::int AS count FROM generations
     WHERE anon_id = $1 AND created_at >= date_trunc('day', now())`,
    [anonId]
  );
  return rows[0].count;
}

export async function totalGenerationsToday(database: Pick<PoolClient, 'query'> = pool): Promise<number> {
  const { rows } = await database.query(
    `SELECT count(*)::int AS count FROM generations
     WHERE created_at >= date_trunc('day', now())`
  );
  return rows[0].count;
}

export type RateLimitCheck =
  | { allowed: true }
  | { allowed: false; reason: 'user_limit' | 'global_limit' };


export async function checkRateLimits(anonId: string, database: Pick<PoolClient, 'query'> = pool): Promise<RateLimitCheck> {
  const [userCount, globalCount] = await Promise.all([
    generationsToday(anonId, database),
    totalGenerationsToday(database),
  ]);

  if (globalCount >= GLOBAL_DAILY_CEILING) {
    return { allowed: false, reason: 'global_limit' };
  }

  if (userCount >= FREE_DAILY_LIMIT) {
    return { allowed: false, reason: 'user_limit' };
  }

  return { allowed: true };
}
