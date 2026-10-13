import crypto from 'node:crypto';
import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import { geminiAdrResponseSchema, GeneratedAdrSchema, type Adr } from '../schema/adr.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are writing Architecture Decision Records (ADRs) that explain the reasoning behind decisions already present in a system's design. You will be given the system's tech stack choices and its architecture (nodes and edges) as JSON.

For EVERY item in techStack, write exactly one ADR:
- subjectType: "tech_stack"
- subjectId: that item's exact "category" value.
- title: a short, specific title for the decision (e.g. "Use PostgreSQL as the primary database").
- context: the problem or constraint that made this decision necessary.
- decision: what was chosen, stated plainly (restate the item's "choice" in your own words — don't just repeat its "rationale" verbatim).
- alternatives: 1-3 plausible alternatives that could have been chosen instead, each with a believable reason it was rejected in this context.
- consequences: 2-4 real implications of this choice — include both genuine benefits and real trade-offs or lock-in, not just praise.

For the architecture, write ADRs only for decisions that represent a genuine design choice with real alternatives — not simply "this component exists." A plain pass-through component with no real alternative worth discussing does not need an ADR. It is fine to produce zero, one, or several architecture ADRs depending on what the architecture actually contains.
- For a notable NODE (e.g. a message queue, a cache, a deliberate choice of datastore scoped to one service): subjectType "architecture_node", subjectId exactly that node's "id".
- For a notable EDGE (e.g. why there's a queue between two particular components instead of a direct call): subjectType "architecture_edge", subjectId formatted exactly as "fromId:toId" using that edge's real "from" and "to" values.
- Follow the same context/decision/alternatives/consequences guidance as above.

Rules:
- Use real category values, node ids, and edge from/to pairs only — never invent one.
- Never write two ADRs for the same subjectType+subjectId pair.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  const payload = { techStack: system.techStack, architecture: system.architecture };
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem:\n"""\n${JSON.stringify(payload)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class AdrValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// A stable key over just the parts of the system ADRs actually explain
// — iterating a map's dataModel or features shouldn't invalidate ADRs
// that have nothing to do with either. Not a security hash, just a
// deterministic "has this part of the system changed" fingerprint.
export function techArchHash(system: MapprSystem): string {
  const payload = JSON.stringify({ techStack: system.techStack, architecture: system.architecture });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Drops any ADR whose subject doesn't correspond to something real,
// and any later ADR that duplicates an earlier one's subject — same
// "ground against real ids, drop what doesn't match" pattern as the
// other AI-backed features.
function groundAdrs(adrs: Adr[], system: MapprSystem): Adr[] {
  const validCategories = new Set(system.techStack.map((t) => t.category));
  const validNodeIds = new Set(system.architecture.nodes.map((n) => n.id));
  const validEdgeKeys = new Set(system.architecture.edges.map((e) => `${e.from}:${e.to}`));

  const seen = new Set<string>();
  const grounded: Adr[] = [];

  for (const adr of adrs) {
    const isGrounded =
      (adr.subjectType === 'tech_stack' && validCategories.has(adr.subjectId)) ||
      (adr.subjectType === 'architecture_node' && validNodeIds.has(adr.subjectId)) ||
      (adr.subjectType === 'architecture_edge' && validEdgeKeys.has(adr.subjectId));
    if (!isGrounded) continue;

    const key = `${adr.subjectType}:${adr.subjectId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    grounded.push(adr);
  }

  return grounded;
}

export async function generateAdrs(system: MapprSystem): Promise<Adr[]> {
  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedAdrSchema,
      geminiResponseSchema: geminiAdrResponseSchema,
      groqSchemaName: 'adr_set',
    });
    return groundAdrs(generated.adrs, system);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new AdrValidationError(err.zodError);
    }
    throw err;
  }
}