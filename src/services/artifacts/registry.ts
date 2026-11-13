import { createHash } from 'node:crypto';
import type { MapprSystem } from '../../schema/mapprSystem.js';

export const ARTIFACT_POLICY = 's5a-provenance-v1';
export const ARTIFACTS = {
  api_contract: { table: 'api_contracts', route: 'api-contract', key: 'version', inputs: 'full', fields: { endpoints: 'endpoints' } },
  relational_schema: { table: 'relational_schemas', route: 'relational-schema', key: 'version', inputs: 'dataModel', fields: { tables: 'tables' } },
  document_schema: { table: 'document_schemas', route: 'document-schema', key: 'version', inputs: 'dataModel', fields: { collections: 'collections' } },
  readme: { table: 'readmes', route: 'readme', key: 'version', inputs: 'full', fields: { overview: 'overview', getting_started: 'gettingStarted' } },
  adrs: { table: 'adrs', route: 'adrs', key: 'hash', inputs: 'techArch', fields: { adrs: 'adrs' } },
  env_vars: { table: 'env_vars', route: 'env-vars', key: 'hash', inputs: 'techArch', fields: { vars: 'vars' } },
  deployment: { table: 'deployments', route: 'deployment', key: 'hash', inputs: 'techArch', fields: { components: 'components', environments: 'environments', cicd_steps: 'cicdSteps', migrations: 'migrations' } },
  critique: { table: 'architecture_reviews', route: 'critique', key: 'single', inputs: 'full', fields: { findings: 'findings' } },
  requirements: { table: 'missing_requirement_reviews', route: 'requirements', key: 'single', inputs: 'full', fields: { findings: 'findings' } },
  traceability: { table: 'traceability_reviews', route: 'traceability', key: 'single', inputs: 'full', fields: { links: 'links' } },
} as const;
export type ArtifactType = keyof typeof ARTIFACTS;
export const artifactTypes = Object.keys(ARTIFACTS) as ArtifactType[];
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const generatorVersion = (kind: ArtifactType) => `${kind}:s5a-1`;
// Deliberately identical to existing ADR storage hashing; not the provenance hash.
export const legacyTechArchHash = (system: MapprSystem) => digest(JSON.stringify({ techStack: system.techStack, architecture: system.architecture }));
export function storageKey(kind: ArtifactType, system: MapprSystem, revision: number): string {
  return ARTIFACTS[kind].key === 'version' ? String(revision) : ARTIFACTS[kind].key === 'hash' ? legacyTechArchHash(system) : 'single';
}
// SQL is selected only from this fixed registry, never a client/model path.
export function inputExpression(kind: ArtifactType, expression: string): string {
  const inputs = ARTIFACTS[kind].inputs;
  return inputs === 'dataModel' ? `(${expression}->'dataModel')::text` : inputs === 'techArch'
    ? `jsonb_build_object('techStack',${expression}->'techStack','architecture',${expression}->'architecture')::text`
    : `(${expression})::text`;
}
export const inputFingerprint = (kind: ArtifactType, text: string) => digest(JSON.stringify([ARTIFACT_POLICY, generatorVersion(kind), text]));
export function serializeArtifact(kind: ArtifactType, row: Record<string, any>) {
  const result: Record<string, any> = { mapId: row.map_id, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  if (ARTIFACTS[kind].key === 'version') result.version = row.version;
  if (ARTIFACTS[kind].key === 'hash') result.techArchHash = row.tech_arch_hash;
  for (const [column, field] of Object.entries(ARTIFACTS[kind].fields)) result[field] = row[column];
  return result;
}
