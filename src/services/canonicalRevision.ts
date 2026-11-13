import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { revisionTransaction } from '../db/revisionTransaction.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';
import type { ArchitecturePatch } from '../schema/architecturePatch.js';
import { isRevision, MAX_REVISION } from './revisionState.js';
import { recordSuccessfulGeneration, type DailyAttempt } from './dailyAdmission.js';

// Default off until S3B has paused ALL canonical writers, applied expansion,
// completed reviewed backfill, and coordinated every instance's rollout.
export function revisionWritesEnabled(): boolean {
  return process.env.MAPPR_REVISION_WRITES_ENABLED === 'true';
}

export class RevisionNotReadyError extends Error {
  constructor() { super('Revision migration/backfill is not ready for this map.'); }
}
export class CanonicalMapNotFoundError extends Error {}
export class RevisionConflictError extends Error {
  constructor(public expectedBaseRevision: number, public currentRevision: number) {
    super('The map changed after generation began. Refresh and try the instruction again.');
  }
}

const mapRead = `SELECT m.id, m.anon_id, m.input_description, m.data, m.current_revision, m.created_at, m.updated_at,
  h.minimum_revision, h.maximum_revision, h.snapshot_count,
  v.data IS NOT DISTINCT FROM m.data AS snapshot_matches
  FROM maps m
  LEFT JOIN LATERAL (SELECT MIN(version) AS minimum_revision, MAX(version) AS maximum_revision,
    COUNT(*)::integer AS snapshot_count FROM map_versions WHERE map_id = m.id) h ON true
  LEFT JOIN map_versions v ON v.map_id = m.id AND v.version = h.maximum_revision
  WHERE m.id = $1`;

interface RevisionedMap {
  id: string; anon_id: string; input_description: string; data: MapprSystem;
  current_revision: number; created_at: Date; updated_at: Date;
  minimum_revision: number; maximum_revision: number; snapshot_count: number; snapshot_matches: boolean;
}

function ready(row: RevisionedMap): void {
  if (!isRevision(row.current_revision) || row.minimum_revision !== 1
    || row.maximum_revision !== row.current_revision || row.snapshot_count !== row.current_revision
    || row.snapshot_matches !== true || !MapprSystemSchema.safeParse(row.data).success) {
    throw new RevisionNotReadyError();
  }
}

function schemaFailure(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === '42703' || code === '42P01') throw new RevisionNotReadyError();
  throw error;
}

export async function readRevisionedMap(mapId: string, database: Pick<PoolClient, 'query'> = pool): Promise<RevisionedMap> {
  try {
    const { rows } = await database.query<RevisionedMap>(mapRead, [mapId]);
    const row = rows[0];
    if (!row) throw new CanonicalMapNotFoundError();
    ready(row);
    return row;
  } catch (error) { return schemaFailure(error); }
}

export interface CanonicalBase { revision: number; rawData: MapprSystem; system: MapprSystem }
export async function readCanonicalBase(mapId: string, anonId: string): Promise<CanonicalBase> {
  const map = await readRevisionedMap(mapId);
  if (map.anon_id !== anonId.toLowerCase()) throw new CanonicalMapNotFoundError();
  return { revision: map.current_revision, rawData: map.data, system: MapprSystemSchema.parse(map.data) };
}

async function snapshot(client: PoolClient, mapId: string, version: number, data: MapprSystem, patch: ArchitecturePatch | null, summary: string) {
  const written = await client.query(`INSERT INTO map_versions (map_id, version, data, patch, summary)
    VALUES ($1, $2, $3, $4, $5)`, [mapId, version, JSON.stringify(data), patch === null ? null : JSON.stringify(patch), summary]);
  if (written.rowCount !== 1) throw new Error('Canonical snapshot was not written');
}

export async function createRevisionedMap(anonId: string, description: string, data: MapprSystem, attempt?: DailyAttempt) {
  if (!MapprSystemSchema.safeParse(data).success) throw new RevisionNotReadyError();
  try {
    return await revisionTransaction(pool, async client => {
      const { rows } = await client.query(`INSERT INTO maps (anon_id, input_description, data, current_revision)
        VALUES ($1, $2, $3, 1) RETURNING id, created_at, updated_at`, [anonId, description, JSON.stringify(data)]);
      const map = rows[0];
      if (!map || rows.length !== 1) throw new Error('Canonical map was not created');
      await snapshot(client, map.id, 1, data, null, 'Initial generation');
      await recordSuccessfulGeneration(client, anonId, map.id, attempt);
      return { id: map.id as string, createdAt: map.created_at as Date, updatedAt: map.updated_at as Date, data, revision: 1 };
    });
  } catch (error) { return schemaFailure(error); }
}

export async function commitArchitectureRevision(input: {
  mapId: string; anonId: string; base: CanonicalBase;
  result: { newSystem: MapprSystem; groundedPatch: ArchitecturePatch; summary: string };
  attempt?: DailyAttempt;
}): Promise<number> {
  if (!MapprSystemSchema.safeParse(input.result.newSystem).success) throw new RevisionNotReadyError();
  try {
    return await revisionTransaction(pool, async client => {
      const locked = await client.query(`SELECT id, anon_id, current_revision,
        data IS NOT DISTINCT FROM $2::jsonb AS base_matches FROM maps WHERE id = $1 FOR UPDATE`,
      [input.mapId, JSON.stringify(input.base.rawData)]);
      const map = locked.rows[0];
      if (!map || map.anon_id !== input.anonId.toLowerCase()) throw new CanonicalMapNotFoundError();
      if (!isRevision(map.current_revision)) throw new RevisionNotReadyError();
      if (map.current_revision !== input.base.revision) throw new RevisionConflictError(input.base.revision, map.current_revision);
      if (map.base_matches !== true || map.current_revision === MAX_REVISION) throw new RevisionNotReadyError();
      // Separate statement AFTER obtaining the row lock: history now reflects
      // a preceding writer that committed while this transaction waited.
      const current = await client.query<RevisionedMap>(mapRead, [input.mapId]);
      if (!current.rows[0]) throw new CanonicalMapNotFoundError();
      ready(current.rows[0]);
      const revision = map.current_revision + 1;
      await snapshot(client, input.mapId, revision, input.result.newSystem, input.result.groundedPatch, input.result.summary);
      const updated = await client.query('UPDATE maps SET data = $1, current_revision = $2, updated_at = now() WHERE id = $3',
        [JSON.stringify(input.result.newSystem), revision, input.mapId]);
      if (updated.rowCount !== 1) throw new Error('Canonical map was not updated');
      await recordSuccessfulGeneration(client, input.anonId, input.mapId, input.attempt);
      return revision;
    });
  } catch (error) { return schemaFailure(error); }
}
