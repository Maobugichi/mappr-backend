import type { RequestHandler, Response } from 'express';
import { isUuid } from './anonSession.js';
import { CanonicalMapNotFoundError, RevisionNotReadyError } from '../services/canonicalRevision.js';
import { ArtifactError, resolveArtifact, withArtifactSnapshot } from '../services/artifacts/provenance.js';
import { ARTIFACTS, artifactTypes, digest, serializeArtifact, type ArtifactType } from '../services/artifacts/registry.js';
import { renderRelationalSchema, RELATIONAL_DIALECTS, type RelationalDialect } from '../services/relationalRender.js';
import { renderDocumentSchema } from '../services/documentRender.js';
import { renderAdrs } from '../services/adrRender.js';
import { renderEnvVars } from '../services/envVarsRender.js';
import { renderReadme } from '../services/readmeRender.js';
import { renderDeployment } from '../services/deploymentRender.js';

export const ARTIFACT_EXPORTS: Partial<Record<ArtifactType, string>> = {
  relational_schema: 'sql', document_schema: 'script', adrs: 'markdown', env_vars: 'file', readme: 'markdown', deployment: 'markdown',
};
export function artifactRouteError(res: Response, error: unknown): boolean {
  // Preserve named model-validation responses in the existing generator routes.
  if ((error as { zodError?: unknown } | null)?.zodError) return false;
  const driverCode = (error as { code?: string } | null)?.code;
  const safe = error instanceof ArtifactError ? error : error instanceof CanonicalMapNotFoundError
    ? new ArtifactError(404, 'not_found') : error instanceof RevisionNotReadyError
      ? new ArtifactError(503, 'revision_not_ready') : ['42703','42P01','55P03','57014'].includes(driverCode ?? '')
        ? new ArtifactError(503, 'artifact_safety_not_ready') : new ArtifactError(500, 'internal_error');
  res.status(safe.status).json({ error: safe.code, ...safe.details });
  return true;
}
const trackedMetadata = (metadata: Record<string, any>) => ({
  sourceRevision: metadata.sourceRevision, currentRevision: metadata.currentRevision,
  generationId: metadata.generationId, sourceFingerprint: metadata.sourceFingerprint,
  generatorVersion: metadata.generatorVersion, publishedAt: metadata.publishedAt,
  freshness: { status: metadata.status, reason: metadata.reason },
  isCurrent: metadata.status === 'fresh', inspectionOnly: metadata.status !== 'fresh',
});

// Mounted before all existing artifact readers/exporters. Every known export
// is handled here, including legacy URLs without a tracked query. On failure
// there is no fall-through to the older unchecked render implementation.
export const artifactReadMiddleware: RequestHandler = async (req, res, next) => {
  if (!['GET','HEAD'].includes(req.method)) { next(); return; }
  const match = req.path.match(/^\/maps\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/i);
  if (!match) { next(); return; }
  // Match Express's default case-insensitive routing, so alternate spellings
  // cannot reach the older unchecked exporter after this guard.
  const suffix = match[3]?.toLowerCase();
  const kind = artifactTypes.find(kind => ARTIFACTS[kind].route === match[2].toLowerCase());
  if (!kind || (suffix && ARTIFACT_EXPORTS[kind] !== suffix)) { next(); return; }
  res.set('Cache-Control', 'no-store'); res.vary('Cookie');
  const mapId = match[1].toLowerCase(), exporting = Boolean(suffix);
  try {
    if (!isUuid(mapId)) throw new ArtifactError(404, 'not_found');
    const mode = req.query.freshness, include = req.query.includeStale;
    if (mode !== undefined && mode !== 'tracked') throw new ArtifactError(400, 'invalid_request');
    if (include !== undefined && (exporting || mode !== 'tracked' || !['true','false'].includes(String(include)) || typeof include !== 'string')) {
      throw new ArtifactError(400, 'invalid_request');
    }
    const inspection = include === 'true';
    if (inspection && !req.hasEstablishedAnonSession) throw new ArtifactError(401, 'session_required');
    if (kind === 'relational_schema' && exporting && (typeof req.query.dialect !== 'string'
      || !RELATIONAL_DIALECTS.includes(req.query.dialect as RelationalDialect))) throw new ArtifactError(400, 'invalid_dialect');
    const response = await withArtifactSnapshot(mapId, async (client, context) => {
      if (inspection && context.ownerId !== req.anonId.toLowerCase()) throw new ArtifactError(404, 'not_found');
      const resolved = await resolveArtifact(client, mapId, kind, context, !exporting && mode === undefined);
      const { row, metadata } = resolved;
      if (!row) throw new ArtifactError(404, 'not_found');
      if ((exporting || mode === 'tracked') && !inspection && metadata.status !== 'fresh') throw new ArtifactError(409, 'artifact_stale', {
        ...trackedMetadata(metadata), inspectionUrl: `/maps/${mapId}/${ARTIFACTS[kind].route}?freshness=tracked&includeStale=true`,
      });
      if (!exporting) return { json: { ...serializeArtifact(kind, row.record), ...trackedMetadata(metadata),
        readMode: mode === 'tracked' ? 'tracked' : 'legacy' }, metadata };
      const record = serializeArtifact(kind, row.record), dependencies: Record<string, unknown> = {}, omitted: string[] = [];
      const optional = async (type: ArtifactType) => {
        const other = await resolveArtifact(client, mapId, type, context);
        dependencies[type] = { generationId: other.metadata.generationId, status: other.metadata.status };
        if (!other.row || other.metadata.status !== 'fresh') { omitted.push(type); return null; }
        return serializeArtifact(type, other.row.record);
      };
      let text: string;
      switch (kind) {
        case 'relational_schema': text = renderRelationalSchema(record.tables, req.query.dialect as RelationalDialect); break;
        case 'document_schema': text = renderDocumentSchema(record.collections); break;
        case 'adrs': text = renderAdrs(record.adrs, context.system.meta.productName); break;
        case 'env_vars': text = renderEnvVars(record.vars, context.system); break;
        case 'readme': {
          const api = await optional('api_contract'), relational = await optional('relational_schema'), document = await optional('document_schema'), adrs = await optional('adrs');
          text = renderReadme(context.system, { overview: record.overview, gettingStarted: record.gettingStarted }, {
            hasApiContract: Boolean(api), hasRelationalSchema: Boolean(relational), hasDocumentSchema: Boolean(document), hasAdrs: Boolean(adrs),
          }); break;
        }
        case 'deployment': {
          const environment = await optional('env_vars');
          text = renderDeployment({ components: record.components, environments: record.environments, cicdSteps: record.cicdSteps, migrations: record.migrations }, context.system, environment?.vars ?? null); break;
        }
        default: throw new ArtifactError(404, 'not_found');
      }
      if (omitted.length) text += `\n\n> Optional generated artifacts omitted because no verified current output exists: ${omitted.join(', ')}.\n`;
      return { text, metadata, renderFingerprint: digest(JSON.stringify({ generationId: metadata.generationId, revision: context.revision,
        dependencies, dialect: req.query.dialect ?? null, renderer: 's5a-1' })) };
    });
    res.set('X-Mappr-Current-Revision', String(response.metadata.currentRevision));
    if (response.metadata.generationId) res.set('X-Mappr-Artifact-Generation', response.metadata.generationId);
    if ('json' in response) { res.json(response.json); return; }
    res.set('X-Mappr-Render-Fingerprint', response.renderFingerprint);
    res.type(suffix === 'markdown' ? 'text/markdown' : 'text/plain').send(response.text);
  } catch (error) { if (!artifactRouteError(res, error)) res.status(500).json({ error: 'internal_error' }); }
};
