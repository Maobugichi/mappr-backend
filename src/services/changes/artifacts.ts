import type { PoolClient } from 'pg';
import { artifactInventory } from '../artifacts/provenance.js';
import { ARTIFACTS, artifactTypes, type ArtifactType } from '../artifacts/registry.js';

export const ARTIFACT_TABLES = Object.fromEntries(artifactTypes.map(kind => [kind, ARTIFACTS[kind].table])) as Record<ArtifactType, string>;
export { changeWarnings } from './warnings.js';
// S4 callers already hold the parent map lock. All S5 publishers use that lock,
// so this inventory cannot race a participating publisher. It never writes metadata.
export async function conservativeArtifacts(client: Pick<PoolClient, 'query'>, mapId: string, candidateText?: string, revision?: number) {
  return artifactInventory(client, mapId, candidateText, revision);
}
