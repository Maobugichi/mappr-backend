import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import { geminiEnvVarsResponseSchema, GeneratedEnvVarsSchema, type EnvVar } from '../schema/envVars.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are listing the environment variables a software system needs, given its tech stack and architecture as JSON.

For each variable:
- name: UPPER_SNAKE_CASE (e.g. DATABASE_URL).
- description: one sentence on what it is for, and where to get the value from when that isn't obvious.
- required: true if the system cannot start or work without it; false for optional tuning or config that has a sensible default.
- secret: true for anything that grants access or must never be committed (API keys, passwords, tokens, signing secrets, connection strings that contain credentials); false for plain configuration (PORT, NODE_ENV, public URLs, feature flags).
- placeholder: an obviously fake example value. For secrets use clearly placeholder text such as "your-api-key-here" or "postgresql://user:password@localhost:5432/dbname" — never a realistic-looking real key or token. For non-secret config a realistic default is fine (e.g. 3000, development).
- nodeId: the id of the architecture node that uses this variable, exactly as given — or null if it is shared across the whole system.
- techStackCategory: the exact "category" of the tech stack item this variable is for — or null if it isn't tied to one (e.g. PORT).

Cover:
- Connection details and credentials for every datastore, cache, queue and external service in the tech stack or architecture.
- Credentials and keys for any third-party service named in the tech stack (payments, email, SMS, auth, storage, and so on).
- The basic runtime config a system of this kind needs (PORT, NODE_ENV or equivalent, public or base URLs, and session or token signing secrets where authentication is part of the system).

Rules:
- Only include variables the given tech stack and architecture actually imply — do not invent services that aren't there.
- One entry per variable name. If several components use the same variable (e.g. DATABASE_URL), list it once, with nodeId set to the primary consuming node or null.
- Use real node ids and tech stack categories only.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  const payload = { techStack: system.techStack, architecture: system.architecture };
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem:\n"""\n${JSON.stringify(payload)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class EnvVarsValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// The schema deliberately has no regex on `name` (see envVars.ts), so
// the format is enforced here instead. A lowercase or dashed name — the
// common slip — is fixed rather than thrown away; only a name that
// can't be made into a valid identifier at all (e.g. one that starts
// with a digit) returns null and gets dropped.
function normalizeEnvVarName(name: string): string | null {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? normalized : null;
}

// Normalizes names, drops unusable ones and later duplicates, and nulls
// out (rather than drops) a nodeId or techStackCategory that doesn't
// match anything real — the variable itself is still useful, only the
// dangling link is removed. Same "null the dangling part, keep the
// rest" pattern as the schema features.
function groundEnvVars(vars: EnvVar[], system: MapprSystem): EnvVar[] {
  const validNodeIds = new Set(system.architecture.nodes.map((n) => n.id));
  const validCategories = new Set(system.techStack.map((t) => t.category));

  const seen = new Set<string>();
  const grounded: EnvVar[] = [];

  for (const envVar of vars) {
    const name = normalizeEnvVarName(envVar.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    grounded.push({
      ...envVar,
      name,
      nodeId: envVar.nodeId && validNodeIds.has(envVar.nodeId) ? envVar.nodeId : null,
      techStackCategory:
        envVar.techStackCategory && validCategories.has(envVar.techStackCategory)
          ? envVar.techStackCategory
          : null,
    });
  }

  return grounded;
}

export async function generateEnvVars(system: MapprSystem): Promise<EnvVar[]> {
  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedEnvVarsSchema,
      geminiResponseSchema: geminiEnvVarsResponseSchema,
      groqSchemaName: 'env_vars',
    });
    return groundEnvVars(generated.vars, system);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new EnvVarsValidationError(err.zodError);
    }
    throw err;
  }
}