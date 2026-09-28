import { AIGenerationError, generateStructured } from './aiClient.js'
import type { ZodError } from 'zod';
import {
  geminiTraceabilityResponseSchema,
  GeneratedTraceabilitySchema,
  type TraceLink,
} from '../schema/traceability.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are checking whether a system's stated features are actually backed by its architecture. You will be given the full structured system model as JSON.

For EVERY feature in the given features list, decide which architecture node(s) — if any — actually implement it, based on what each node's description and connections suggest it does.

Rules:
- Return exactly one entry per feature in the given features list, in any order, using its real id from features[].id.
- nodeIds should list the architecture node id(s) that genuinely implement this feature — reference real ids from architecture.nodes. It is completely normal and expected for this to be empty: many generated systems have features with no corresponding component, and that is the case this check exists to surface. Do not force a tenuous connection just to avoid an empty list.
- A single feature may reasonably map to multiple nodes (e.g. "Checkout" might involve both a Payment Service and an Orders node), and a single node may back multiple features.
- note is optional — use it only when the reasoning isn't obvious from the node names alone (e.g. "implied by the auth service's session handling" rather than a literal name match).
- Do not invent feature ids or node ids that are not present in the given lists.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem model:\n"""\n${JSON.stringify(system)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}
export class TraceabilityValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('Gemini response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Grounds every link against what's really in the system — drops
// nodeIds that don't exist, and drops whole links whose featureId
// doesn't exist. Same guardrail pattern as the other three features.
function groundLinks(
  links: TraceLink[],
  validFeatureIds: Set<string>,
  validNodeIds: Set<string>
): TraceLink[] {
  return links
    .filter((link) => validFeatureIds.has(link.featureId))
    .map(({ note, ...rest }) => {
      const nodeIds = rest.nodeIds.filter((id) => validNodeIds.has(id));
      
      return note == null ? { ...rest, nodeIds } : { ...rest, nodeIds, note };
    });
}

export async function generateTraceability(system: MapprSystem): Promise<TraceLink[]> {
  const validFeatureIds = new Set(system.features.map((f) => f.id));
  const validNodeIds = new Set(system.architecture.nodes.map((n) => n.id));

  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedTraceabilitySchema,
      geminiResponseSchema: geminiTraceabilityResponseSchema,
      groqSchemaName: 'traceability',
    });
    return groundLinks(generated.links, validFeatureIds, validNodeIds);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new TraceabilityValidationError(err.zodError);
    }
    throw err;
  }
}