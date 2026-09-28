import { AIGenerationError, generateStructured } from './aiClient.js';
import type { ZodError } from 'zod';
import crypto from 'node:crypto';
import {
  geminiFindingResponseSchema,
  GeneratedReviewSchema,
  type GeneratedFinding,
} from '../schema/architectureFinding.js';
import type { MapprSystem } from '../schema/mapprSystem.js';
import type { ArchitectureFinding } from '../schema/architectureFinding.js';


const SYSTEM_INSTRUCTIONS = `You are a senior software architect performing a critical review of a system that has already been designed. You will be given the full structured system model — product, users, features, tech stack, architecture nodes/edges, data model, and development plan — as JSON.

Identify real architectural risks, weaknesses, missing considerations, questionable decisions, tight coupling, scalability concerns, security concerns, maintainability problems, and similar issues.

Rules:
- Ground every finding in the actual system you were given. Reference real architecture node ids in affectedNodeIds wherever a finding concerns specific components. Do not invent node ids that are not present in the architecture.nodes list you were given.
- Do not produce generic, one-size-fits-all advice ("consider using a message queue", "add monitoring") unless it is genuinely justified by something specific in this system. Two different systems should produce meaningfully different findings.
- Set observationType to:
  - "observed" when the issue is directly visible in the given architecture/data model (e.g. two nodes are directly connected in a way that creates tight coupling).
  - "inferred" when the issue is a reasonable conclusion from the system but not explicitly stated (e.g. the tech stack choice implies a scaling ceiling not mentioned anywhere).
  - "recommended" when it is a proposed improvement rather than a flaw currently present.
- Only report real issues. If the system is genuinely solid in some area, do not manufacture a finding to pad the list. Prefer fewer, substantive findings over many shallow ones. Typically 2-8 findings is appropriate; do not exceed 15.
- Each finding's description should explain the actual mechanism of the problem (what breaks, and how) — not a restatement of the title.
- The recommendation should be concrete and actionable, referencing the specific components involved.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem model:\n"""\n${JSON.stringify(system)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}
export class ReviewValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('Gemini response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Drops any affectedNodeIds that don't correspond to a real architecture
// node. Gemini is instructed not to invent ids, but this is the actual
// guarantee — an ungrounded reference here would undermine the entire
// point of the feature, so it's enforced deterministically rather than
// trusted from the model output.
function groundFinding(finding: GeneratedFinding, validNodeIds: Set<string>): ArchitectureFinding {
  return {
    ...finding,
    id: crypto.randomUUID(),
    dismissed: false,
    affectedNodeIds: finding.affectedNodeIds.filter((id) => validNodeIds.has(id)),
  };
}

export async function generateArchitectureReview(
  system: MapprSystem
): Promise<ArchitectureFinding[]> {
  const validNodeIds = new Set(system.architecture.nodes.map((node) => node.id));

  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedReviewSchema,
      geminiResponseSchema: geminiFindingResponseSchema,
      groqSchemaName: 'architecture_review',
    });
    return generated.findings.map((finding) => groundFinding(finding, validNodeIds));
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new ReviewValidationError(err.zodError);
    }
    throw err;
  }
}