import type { Pool, PoolClient } from 'pg';

export type RevisionDatabase = Pick<Pool, 'connect'>;

// SQL-only callbacks: acquire connections only after external AI work finishes.
export async function revisionTransaction<T>(database: RevisionDatabase, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}
