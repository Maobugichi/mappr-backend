import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { revisionTransaction } from '../../db/revisionTransaction.js';
import { MapprSystemSchema, type MapprSystem } from '../../schema/mapprSystem.js';
import { readRevisionedMap } from '../canonicalRevision.js';
import { ARTIFACTS, ARTIFACT_POLICY, artifactTypes, digest, generatorVersion, inputExpression, inputFingerprint, storageKey, type ArtifactType } from './registry.js';

export class ArtifactError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) { super(code); }
}
type Client = Pick<PoolClient, 'query'>;
type Row = Record<string, any>;
interface Stored { record: Row; payload_text: string; provenance: Row | null; generation_id: string | null }
export interface ArtifactSource {
  kind: ArtifactType; mapId: string; actorId: string; generationId: string; revision: number;
  system: MapprSystem; key: string; fingerprint: string; slotToken: string | null;
}
export async function artifactReadTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='10s'"); await client.query("SET LOCAL lock_timeout='1s'");
    return await work(client);
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
}
async function mapContext(client: Client, mapId: string) {
  const map = await readRevisionedMap(mapId, client);
  return { map, system: MapprSystemSchema.parse(map.data) };
}
async function inputs(client: Client, mapId: string, kind: ArtifactType, canonicalText?: string) {
  const expression = canonicalText === undefined ? 'm.data' : '$2::jsonb';
  const { rows: [row] } = await client.query(`/* artifacts:inputs:${kind} */ SELECT ${inputExpression(kind, expression)} AS input_text
    FROM public.maps m WHERE m.id=$1`, canonicalText === undefined ? [mapId] : [mapId, canonicalText]);
  if (!row) throw new ArtifactError(404, 'not_found');
  return inputFingerprint(kind, row.input_text);
}
export async function storedArtifacts(client: Client, mapId: string, kind: ArtifactType): Promise<Stored[]> {
  return (await client.query(`/* artifacts:rows:${kind} */ SELECT to_jsonb(a)-'generation_id' AS record,
    (to_jsonb(a)-'generation_id')::text AS payload_text,a.generation_id,
    to_jsonb(g)-'payload' AS provenance FROM public.${ARTIFACTS[kind].table} a
    LEFT JOIN public.artifact_generations g ON g.id=a.generation_id AND g.map_id=a.map_id AND g.artifact_type=$2
    WHERE a.map_id=$1 ORDER BY COALESCE(g.published_at,a.updated_at) DESC,a.id DESC`, [mapId, kind])).rows;
}
const keyOf = (kind: ArtifactType, row: Stored) => ARTIFACTS[kind].key === 'version' ? String(row.record.version)
  : ARTIFACTS[kind].key === 'hash' ? row.record.tech_arch_hash : 'single';
const token = (row?: Stored) => row ? digest(JSON.stringify([row.generation_id, row.payload_text])) : null;
function verifiedPayload(row: Stored) {
  return row.provenance && row.provenance.payload_fingerprint === digest(row.payload_text)
    && row.provenance.source_revision !== null;
}
export function freshness(kind: ArtifactType, row: Stored | undefined, fingerprint: string, revision: number) {
  const base = { currentRevision: revision, sourceRevision: row?.provenance?.source_revision ?? null,
    generationId: row?.generation_id ?? null, sourceFingerprint: row?.provenance?.input_fingerprint ?? null,
    generatorVersion: row?.provenance?.generator_version ?? null, publishedAt: row?.provenance?.published_at ?? null };
  if (!row) return { ...base, status: 'missing', reason: 'not_generated' };
  if (!row.provenance || row.provenance.source_revision === null) return { ...base, status: 'stale', reason: 'provenance_unknown' };
  if (!verifiedPayload(row)) return { ...base, status: 'stale', reason: 'payload_changed' };
  if (row.provenance.dependency_policy !== ARTIFACT_POLICY || row.provenance.generator_version !== generatorVersion(kind)) {
    return { ...base, status: 'stale', reason: 'generator_changed' };
  }
  return row.provenance.input_fingerprint === fingerprint
    ? { ...base, status: 'fresh', reason: 'inputs_unchanged' } : { ...base, status: 'stale', reason: 'source_changed' };
}
export async function resolveArtifact(client: Client, mapId: string, kind: ArtifactType,
  context: { system: MapprSystem; revision: number; canonicalText?: string }, legacy = false) {
  const fingerprint = await inputs(client, mapId, kind, context.canonicalText);
  let rows = await storedArtifacts(client, mapId, kind);
  if (legacy) rows = rows.filter(row => keyOf(kind, row) === storageKey(kind, context.system, context.revision));
  const current = rows.find(row => freshness(kind, row, fingerprint, context.revision).status === 'fresh');
  const row = current ?? rows[0];
  return { row, metadata: freshness(kind, row, fingerprint, context.revision) };
}
export async function withArtifactSnapshot<T>(mapId: string, work: (client: PoolClient, context: { system: MapprSystem; revision: number; ownerId: string }) => Promise<T>) {
  return artifactReadTransaction(async client => {
    const { map, system } = await mapContext(client, mapId);
    return work(client, { system, revision: map.current_revision, ownerId: map.anon_id });
  });
}
export async function captureArtifactSource(mapId: string, actorId: string, kind: ArtifactType): Promise<ArtifactSource> {
  return withArtifactSnapshot(mapId, async (client, context) => {
    if (context.ownerId !== actorId.toLowerCase()) throw new ArtifactError(404, 'not_found');
    const key = storageKey(kind, context.system, context.revision);
    const rows = await storedArtifacts(client, mapId, kind);
    return { kind, mapId, actorId, generationId: randomUUID(), revision: context.revision, system: context.system, key,
      fingerprint: await inputs(client, mapId, kind), slotToken: token(rows.find(row => keyOf(kind, row) === key)) };
  });
}
async function lockOwner(client: PoolClient, mapId: string, actorId: string) {
  await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  const { rows: [row] } = await client.query('/* artifacts:lock */ SELECT id,anon_id FROM public.maps WHERE id=$1 FOR UPDATE', [mapId]);
  if (!row || row.anon_id !== actorId.toLowerCase()) throw new ArtifactError(404, 'not_found');
  return mapContext(client, mapId); // Fresh history statement AFTER map lock.
}
async function saveGeneration(client: PoolClient, kind: ArtifactType, row: Stored, id: string,
  source?: { revision: number; fingerprint: string; generatorVersion: string; policy: string }, origin = 'generated', parentId: string | null = null) {
  // Snapshot exact PostgreSQL JSONB, without a JavaScript reserialization.
  const result = await client.query(`/* artifacts:save:${kind} */ INSERT INTO public.artifact_generations
    (id,map_id,artifact_type,storage_key,origin,source_revision,input_fingerprint,generator_version,dependency_policy,
     payload_fingerprint,payload,parent_id)
    SELECT $1,a.map_id,$2,$3,$4,$5,$6,$7,$8,$9,to_jsonb(a)-'generation_id',$10
    FROM public.${ARTIFACTS[kind].table} a WHERE a.id=$11`,
  [id, kind, keyOf(kind, row), origin, source?.revision ?? null, source?.fingerprint ?? null,
    source?.generatorVersion ?? null, source?.policy ?? null, digest(row.payload_text), parentId, row.record.id]);
  if (result.rowCount !== 1) throw new ArtifactError(503, 'artifact_safety_not_ready');
}
async function archiveUnverified(client: PoolClient, kind: ArtifactType, row?: Stored) {
  if (row && (!row.provenance || row.provenance.payload_fingerprint !== digest(row.payload_text))) {
    await saveGeneration(client, kind, row, randomUUID(), undefined, 'legacy');
  }
}
async function lockArtifactRows(client: PoolClient, mapId: string, kind: ArtifactType) {
  // The parent coordinates application publishers; these locks additionally
  // prevent an existing-row SQL writer from changing the value being archived.
  await client.query(`/* artifacts:lock-rows:${kind} */ SELECT id FROM public.${ARTIFACTS[kind].table}
    WHERE map_id=$1 ORDER BY id FOR UPDATE`, [mapId]);
}
async function attach(client: PoolClient, kind: ArtifactType, row: Stored, id: string) {
  const result = await client.query(`/* artifacts:attach:${kind} */ UPDATE public.${ARTIFACTS[kind].table}
    SET generation_id=$2 WHERE id=$1`, [row.record.id, id]);
  if (result.rowCount !== 1) throw new ArtifactError(503, 'artifact_safety_not_ready');
}
const hydrate = (row: Stored) => ({ ...row.record, created_at: new Date(row.record.created_at), updated_at: new Date(row.record.updated_at) });
export async function publishArtifact<T extends Record<string, any>>(source: ArtifactSource, actorId: string, write: (client: PoolClient) => Promise<T>): Promise<T> {
  if (actorId.toLowerCase() !== source.actorId.toLowerCase()) throw new ArtifactError(404, 'not_found');
  return revisionTransaction(pool, async client => {
    await lockOwner(client, source.mapId, actorId);
    if (await inputs(client, source.mapId, source.kind) !== source.fingerprint) throw new ArtifactError(409, 'artifact_source_changed');
    await lockArtifactRows(client, source.mapId, source.kind);
    const rows = await storedArtifacts(client, source.mapId, source.kind);
    const previous = rows.find(row => keyOf(source.kind, row) === source.key);
    // Same in-process work identity can recover an uncertain COMMIT only while
    // still the matching current publication. No duplicate usage write occurs.
    if (previous?.generation_id === source.generationId && verifiedPayload(previous)) return hydrate(previous) as unknown as T;
    if (token(previous) !== source.slotToken) throw new ArtifactError(409, 'artifact_publication_conflict');
    await archiveUnverified(client, source.kind, previous);
    const result = await write(client); // Existing upsert and usage accounting.
    const after = (await storedArtifacts(client, source.mapId, source.kind)).find(row => keyOf(source.kind, row) === source.key);
    if (!after) throw new ArtifactError(503, 'artifact_safety_not_ready');
    await saveGeneration(client, source.kind, after, source.generationId,
      { revision: source.revision, fingerprint: source.fingerprint, generatorVersion: generatorVersion(source.kind), policy: ARTIFACT_POLICY });
    await attach(client, source.kind, after, source.generationId);
    return result;
  });
}
export async function editReviewArtifact<T extends Record<string, any>>(mapId: string, actorId: string, kind: 'critique' | 'requirements',
  write: (client: PoolClient) => Promise<T | undefined>): Promise<T> {
  return revisionTransaction(pool, async client => {
    await lockOwner(client, mapId, actorId);
    await lockArtifactRows(client, mapId, kind);
    const previous = (await storedArtifacts(client, mapId, kind))[0];
    if (!previous) throw new ArtifactError(404, 'not_found');
    await archiveUnverified(client, kind, previous);
    const result = await write(client);
    if (!result) throw new ArtifactError(404, 'not_found');
    const after = (await storedArtifacts(client, mapId, kind))[0], id = randomUUID();
    const source = verifiedPayload(previous) ? { revision: previous.provenance!.source_revision,
      fingerprint: previous.provenance!.input_fingerprint, generatorVersion: previous.provenance!.generator_version,
      policy: previous.provenance!.dependency_policy } : undefined;
    await saveGeneration(client, kind, after, id, source, source ? 'review_edit' : 'legacy_edit', previous.provenance?.id ?? null);
    await attach(client, kind, after, id);
    return result;
  });
}
export async function artifactInventory(client: Client, mapId: string, canonicalText?: string, revision?: number) {
  const { map, system } = await mapContext(client, mapId);
  const context = { system, revision: revision ?? map.current_revision, canonicalText };
  const artifactFreshness: Record<string, any> = {}, artifactImpacts = [];
  for (const kind of artifactTypes) {
    const { metadata } = await resolveArtifact(client, mapId, kind, context);
    artifactFreshness[kind] = metadata;
    artifactImpacts.push({ artifactType: kind, action: metadata.status === 'missing' ? 'none' : metadata.status === 'fresh' ? 'retain' : 'invalidate', reason: metadata.reason });
  }
  return { artifactFreshness, artifactImpacts };
}
