import { AIGenerationError, generateStructured } from './aiClient.js';
import type { ZodError } from 'zod';
import { geminiResponseSchema } from '../schema/geminiResponseSchema.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are a senior software architect and product designer helping a founder think through a software product before they build it.

Given a natural-language description of a product idea, reason step by step about:
- what the product actually does
- who uses it and how
- the core workflows
- the features required to support those workflows
- the data the product needs to store and how it relates
- external services or integrations required
- scalability and technical considerations
- what the UI needs to communicate

Then produce a system map for the product as JSON matching the provided schema exactly.

Rules:
- Do not produce a generic, one-size-fits-all architecture. Derive everything from the specific product described. Two different product descriptions should produce meaningfully different system maps.
- Every id you generate (for users, features, architecture nodes, data model entities) must be a short, unique, kebab-case string, referenced consistently across sections (e.g. an architecture node id used elsewhere must match exactly).
- features[].dependsOn should reflect real technical/logical dependency ordering, since it drives the development plan.
- developmentPlan phases must respect those dependencies — nothing should appear in an earlier phase than something it depends on.
- Each developmentPlan item has a "description" (what to build/do) and "relatedFeatures" (which features[].id values this item implements or advances). Use the exact ids from the features section — never invent new ids or put ids inside the description text. If an item is pure setup/infra with no specific feature tie (e.g. "initialize repo", "configure CI"), relatedFeatures should be an empty array — don't force a false link.
- techStack choices must be justified by the actual requirements of this product, not defaults.
- Each architecture node's description should explain what that specific piece actually does in this product — real substance a developer could act on, not a restatement of the label or type.
- designSystem should feel intentional and appropriate for this specific product's audience and tone, not generic.`;

function buildPrompt(description: string, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nProduct description:\n"""\n${description}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}
export class GenerationValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('Gemini response failed schema validation after retry');
    this.zodError = zodError;
  }
}


// A null label (Groq's way of saying "no label") is dropped so the
// stored shape stays string-or-absent, as before.
function stripNullLabels(system: MapprSystem): MapprSystem {
  return {
    ...system,
    architecture: {
      ...system.architecture,
      edges: system.architecture.edges.map(({ label, ...rest }) =>
        label == null ? rest : { ...rest, label }
      ),
    },
    dataModel: {
      ...system.dataModel,
      relations: system.dataModel.relations.map(({ label, ...rest }) =>
        label == null ? rest : { ...rest, label }
      ),
    },
  };
}

export async function generateMapprSystem(description: string): Promise<MapprSystem> {
  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(description, retryContext),
      zodSchema: MapprSystemSchema,
      geminiResponseSchema,
      groqSchemaName: 'mappr_system',
    });
    return stripNullLabels(generated);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new GenerationValidationError(err.zodError);
    }
    throw err;
  }
}