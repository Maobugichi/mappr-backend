import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import {
  geminiApiContractResponseSchema,
  GeneratedApiContractSchema,
  type ApiEndpoint,
} from '../schema/apiContract.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are designing a REST API contract for a system. You will be given the full structured system model as JSON.

Design the set of endpoints needed to support every feature in the given features list, operating on the entities in the given data model.

Rules:
- Use real ids: featureIds must reference features[].id, and entityIds must reference dataModel.entities[].id. An endpoint can reference more than one of each (e.g. a checkout endpoint might touch both an Order and a Payment entity).
- path uses REST conventions and inline path parameters in curly braces, e.g. /orders/{orderId}/items. Do not list path parameters separately — they belong only in the path string.
- Cover standard CRUD for every entity that a feature actually needs to create, read, update or delete, plus any feature-specific action endpoints (e.g. POST /orders/{orderId}/cancel) that don't map cleanly to CRUD.
- access is "authenticated" unless the endpoint is clearly meant to be public (e.g. a public signup or health-check endpoint).
- queryParams and bodyFields only ever apply to the fields that endpoint actually needs — not every field on the entity. GET and DELETE should normally have empty bodyFields.
- responseFields should reflect what the endpoint actually returns, not the full entity if only a subset is relevant.
- errors should list the realistic failure cases for this endpoint (e.g. 404 if the resource doesn't exist, 403 if access is denied, 422 for invalid input) — do not list every HTTP status code by rote.
- Do not invent feature ids or entity ids that are not present in the given lists.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem model:\n"""\n${JSON.stringify(system)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class ApiContractValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Grounds every endpoint against what's really in the system — drops
// featureIds/entityIds that don't exist, and drops whole endpoints that
// end up referencing nothing real after that filtering (an endpoint is
// allowed to reference only features or only entities, just not neither).
// Same guardrail pattern as the other four features.
function groundContract(
  endpoints: ApiEndpoint[],
  validFeatureIds: Set<string>,
  validEntityIds: Set<string>
): ApiEndpoint[] {
  return endpoints
    .map((endpoint) => ({
      ...endpoint,
      featureIds: endpoint.featureIds.filter((id) => validFeatureIds.has(id)),
      entityIds: endpoint.entityIds.filter((id) => validEntityIds.has(id)),
    }))
    .filter((endpoint) => endpoint.featureIds.length > 0 || endpoint.entityIds.length > 0);
}

export async function generateApiContract(system: MapprSystem): Promise<ApiEndpoint[]> {
  const validFeatureIds = new Set(system.features.map((f) => f.id));
  const validEntityIds = new Set(system.dataModel.entities.map((e) => e.id));

  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedApiContractSchema,
      geminiResponseSchema: geminiApiContractResponseSchema,
      groqSchemaName: 'api_contract',
    });
    return groundContract(generated.endpoints, validFeatureIds, validEntityIds);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new ApiContractValidationError(err.zodError);
    }
    throw err;
  }
}