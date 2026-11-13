import type { generateStructured as SharedGenerator } from '../aiClient.js';
import type { MapprSystem } from '../../schema/mapprSystem.js';
import { SummaryOutputSchema } from '../../schema/changeProposal.js';
import { buildOverviewPrompt } from './overview.js';
import { ChangeError } from './errors.js';
import { throwIfCancelled, withAISignal } from '../aiCancellation.js';
import type { ZodType } from 'zod';
import type { PreviewRequest } from '../../schema/changeProposal.js';
import { ArchitectureOutputSchema, buildArchitectureChangePrompt } from './architecture.js';
import { TechStackOutputSchema, buildTechStackChangePrompt } from './techStack.js';
import { DatabaseOutputSchema, DATABASE_RELATION_TYPES, buildDatabaseChangePrompt } from './database.js';

export const OVERVIEW_GENERATOR_ID = 'overview-summary:shared-ai-v1';
const responseSchema = { type: 'OBJECT', properties: { summary: { type: 'STRING' } }, required: ['summary'] };
type ProviderOptions = { structured?: typeof SharedGenerator; timeoutMs?: number };
function scopedProvider<T>(definition: { schema: ZodType<T>; response: object; name: string;
  prompt: (base: MapprSystem, instruction: string, context: PreviewRequest['context']) => string; correction: string }, options: ProviderOptions) {
  const timeout = options.timeoutMs ?? 120000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('Invalid change provider deadline');
  return async (base: MapprSystem, instruction: string, parent: AbortSignal,
    context: PreviewRequest['context'] = { activeView: 'overview', selectedTarget: null }) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    const timer = setTimeout(abort, timeout);
    try {
      throwIfCancelled(controller.signal);
      // Lazy import: constructing the production engine never initializes SDKs.
      const structured = options.structured ?? (await withAISignal(import('../aiClient.js'), controller.signal)).generateStructured;
      throwIfCancelled(controller.signal);
      const output = await withAISignal(structured({
        buildPrompt: correction => definition.prompt(base, instruction, context) + (correction ? definition.correction : ''),
        zodSchema: definition.schema, geminiResponseSchema: definition.response, groqSchemaName: definition.name,
        signal: controller.signal, redactErrors: true,
      }), controller.signal);
      throwIfCancelled(controller.signal);
      const validated = definition.schema.safeParse(output);
      if (!validated.success) throw new ChangeError('change_not_valid');
      return validated.data;
    } catch (error) {
      if (controller.signal.aborted) throw new ChangeError('generation_timeout');
      if (error instanceof ChangeError) throw error;
      throw new ChangeError('change_generation_failed');
    } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
  };
}
export function createOverviewProvider(options: ProviderOptions = {}) {
  return scopedProvider({ schema: SummaryOutputSchema, response: responseSchema, name: 'overview_summary', prompt: buildOverviewPrompt,
    correction: '\nThe previous response did not match the schema. Return only one nonblank summary string, at most 4000 characters; no additional fields.' }, options);
}
export const generateOverviewSummary = createOverviewProvider();

export const ARCHITECTURE_GENERATOR_ID = 'architecture-operations:shared-ai-v1';
const string = { type: 'STRING' }, node = { type: 'OBJECT', properties: { id: string, label: string, type: string, description: string }, required: ['id','label','type','description'] };
const edge = { type: 'OBJECT', properties: { from: string, to: string, label: { type: 'STRING', nullable: true } }, required: ['from','to'] };
const architectureResponse = { type: 'OBJECT', properties: { operations: { type: 'ARRAY', items: { anyOf: [
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['upsert_item'] }, collection: { type: 'STRING', enum: ['architecture.nodes'] }, value: node }, required: ['op','collection','value'] },
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['remove_item'] }, collection: { type: 'STRING', enum: ['architecture.nodes'] }, key: string }, required: ['op','collection','key'] },
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['replace_list'] }, path: { type: 'STRING', enum: ['architecture.edges'] }, value: { type: 'ARRAY', items: edge } }, required: ['op','path','value'] },
] } } }, required: ['operations'] };
export function createArchitectureProvider(options: ProviderOptions = {}) {
  return scopedProvider({ schema: ArchitectureOutputSchema, response: architectureResponse, name: 'architecture_change',
    prompt: buildArchitectureChangePrompt, correction: '\nThe previous response did not match the schema. Return only allowed architecture operations and their required fields; no additional fields.' }, options);
}
export const generateArchitectureChange = createArchitectureProvider();

export const TECH_STACK_GENERATOR_ID = 'tech-stack-operations:shared-ai-v1';
const techStackItem = { type: 'OBJECT', properties: { category: string, choice: string, rationale: string }, required: ['category','choice','rationale'] };
const techStackResponse = { type: 'OBJECT', properties: { operations: { type: 'ARRAY', items: { anyOf: [
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['upsert_item'] }, collection: { type: 'STRING', enum: ['techStack'] }, value: techStackItem }, required: ['op','collection','value'] },
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['remove_item'] }, collection: { type: 'STRING', enum: ['techStack'] }, key: string }, required: ['op','collection','key'] },
] } } }, required: ['operations'] };
export function createTechStackProvider(options: ProviderOptions = {}) {
  return scopedProvider({ schema: TechStackOutputSchema, response: techStackResponse, name: 'tech_stack_change',
    prompt: buildTechStackChangePrompt, correction: '\nThe previous response did not match the schema. Return only allowed techStack operations with category, choice and rationale for upserts; no additional fields.' }, options);
}
export const generateTechStackChange = createTechStackProvider();

export const DATABASE_GENERATOR_ID = 'database-operations:shared-ai-v1';
const databaseField = { type: 'OBJECT', properties: { name: string, type: string }, required: ['name','type'] };
const databaseEntity = { type: 'OBJECT', properties: { id: string, name: string, fields: { type: 'ARRAY', items: databaseField } }, required: ['id','name','fields'] };
const databaseRelation = { type: 'OBJECT', properties: { from: string, to: string, type: { type: 'STRING', enum: DATABASE_RELATION_TYPES }, label: { type: 'STRING', nullable: true } }, required: ['from','to','type'] };
const databaseResponse = { type: 'OBJECT', properties: { operations: { type: 'ARRAY', items: { anyOf: [
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['upsert_item'] }, collection: { type: 'STRING', enum: ['dataModel.entities'] }, value: databaseEntity }, required: ['op','collection','value'] },
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['remove_item'] }, collection: { type: 'STRING', enum: ['dataModel.entities'] }, key: string }, required: ['op','collection','key'] },
  { type: 'OBJECT', properties: { op: { type: 'STRING', enum: ['replace_list'] }, path: { type: 'STRING', enum: ['dataModel.relations'] }, value: { type: 'ARRAY', items: databaseRelation } }, required: ['op','path','value'] },
] } } }, required: ['operations'] };
export function createDatabaseProvider(options: ProviderOptions = {}) {
  return scopedProvider({ schema: DatabaseOutputSchema, response: databaseResponse, name: 'database_change',
    prompt: buildDatabaseChangePrompt, correction: '\nThe previous response did not match the schema. Return only allowed dataModel operations with canonical entity/field/relationship fields; no physical-schema fields or additional properties.' }, options);
}
export const generateDatabaseChange = createDatabaseProvider();
