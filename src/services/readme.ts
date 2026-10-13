import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import { geminiReadmeResponseSchema, GeneratedReadmeSchema, type GeneratedReadme } from '../schema/readme.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are writing two sections of a README for a software project, given its product description, features, tech stack, architecture, and development plan as JSON.

Write:
- overview: a short, cohesive introduction (2-4 sentences) that reads like a human wrote it — not a list, not a concatenation of the given fields. It should convey what the product does and give a sense of how it's built, written for a developer skimming the top of a README for the first time.
- gettingStarted: a realistic, ordered sequence of setup and run steps for a developer cloning this project for the first time, grounded in the ACTUAL tech stack given (e.g. if Next.js and PostgreSQL are in the tech stack, steps should reference them specifically, not generic placeholders). Each step has a description, and a command only when the step reduces to one literal command to run (e.g. "npm install"); set command to null for steps that don't (e.g. "Create a PostgreSQL database and set DATABASE_URL in your .env file").

Rules:
- Do not invent features, tech stack items, or architecture components that aren't in the given data — these two sections may reference what's given, but must not contradict or add to it.
- Keep gettingStarted practical and specific to this project's actual stack, not generic boilerplate.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  const payload = {
    meta: system.meta,
    features: system.features,
    techStack: system.techStack,
    architecture: system.architecture,
    developmentPlan: system.developmentPlan,
  };
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nProject:\n"""\n${JSON.stringify(payload)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class ReadmeValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// No grounding step here, unlike every other AI-backed feature — there
// are no ids to dangle. overview and gettingStarted are prose, and the
// instruction against inventing features/stack/architecture is the
// prompt's job, not something code can verify the way an id lookup can.
export async function generateReadme(system: MapprSystem): Promise<GeneratedReadme> {
  try {
    return await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedReadmeSchema,
      geminiResponseSchema: geminiReadmeResponseSchema,
      groqSchemaName: 'readme',
    });
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new ReadmeValidationError(err.zodError);
    }
    throw err;
  }
}