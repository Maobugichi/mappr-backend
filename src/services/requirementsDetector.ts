import { AIGenerationError, generateStructured } from './aiClient.js';
import type { ZodError } from 'zod';
import crypto from 'node:crypto';
import {
  geminiRequirementResponseSchema,
  GeneratedRequirementsReviewSchema,
  type GeneratedRequirement,
} from '../schema/missingRequirement.js';
import type { MapprSystem } from '../schema/mapprSystem.js';
import type { MissingRequirement } from '../schema/missingRequirement.js';



const SYSTEM_INSTRUCTIONS = `You are a senior product engineer reviewing a system's requirements for gaps. You will be given the full structured system model — product, users, features, tech stack, architecture, data model, and development plan — as JSON.

Identify missing requirements: things a system like this would need that aren't currently represented anywhere in the features list. Focus on the product/feature level, not architecture-level concerns (a separate review already covers architecture risk, coupling, and scalability — do not repeat that here).

Look specifically for gaps like:
- Missing auth flows (password reset, email verification, session expiry, account recovery) implied by an existing login/auth feature but not present as its own feature.
- Missing error-handling or failure-state requirements (what happens when a payment fails, a file upload fails, a third-party call times out).
- Missing data-integrity requirements (soft delete vs hard delete, duplicate prevention, data export/deletion for a user who leaves).
- Missing compliance/legal requirements if the product domain implies them (e.g. a payments product needing KYC, a health product needing data-handling rules) — only if the product description genuinely implies this domain, do not assume by default.
- Missing notification/communication requirements (a marketplace with orders but no order-status notifications).
- Edge cases specific to this product's actual users and features (read the users and features carefully — a gap should be specific to what this product does, not generic).
- Missing non-functional requirements only when something about this specific system makes one unusually important (e.g. a real-time feature with no mention of latency/offline behavior).

Rules:
- Every finding must be grounded in something in the given system — the users, features, or product description. A finding phrased as "you should add analytics" with no connection to anything in this system is not acceptable; a finding must explain what existing feature or user need it's a gap in.
- Use relatedFeatureIds to reference the existing features[].id this gap is adjacent to. It is fine for this to be empty if the gap is genuinely disconnected from any current feature (e.g. onboarding entirely absent), but most findings should reference something.
- suggestedFeature should describe a new feature in the same style as the existing features array (a short name plus a description), concrete enough that it could be added directly.
- Do not repeat something that is already covered by an existing feature. Read the features list carefully before flagging something as missing.
- Prefer fewer, substantive findings over many shallow ones. Typically 2-8 findings is appropriate; do not exceed 15.
- If the feature set for this specific product is already thorough, it is fine to report very few or no findings — do not manufacture gaps to pad the list.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nSystem model:\n"""\n${JSON.stringify(system)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class RequirementsReviewValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('Gemini response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Drops any relatedFeatureIds that don't correspond to a real feature —
// same guardrail as architectureCritic.ts's groundFinding, enforced
// deterministically rather than trusted from the model output.
function groundRequirement(
  requirement: GeneratedRequirement,
  validFeatureIds: Set<string>
): MissingRequirement {
  return {
    ...requirement,
    id: crypto.randomUUID(),
    dismissed: false,
    relatedFeatureIds: requirement.relatedFeatureIds.filter((id) => validFeatureIds.has(id)),
  };
}

export async function generateRequirementsReview(
  system: MapprSystem
): Promise<MissingRequirement[]> {
  const validFeatureIds = new Set(system.features.map((feature) => feature.id));

  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedRequirementsReviewSchema,
      geminiResponseSchema: geminiRequirementResponseSchema,
      groqSchemaName: 'requirements_review',
    });
    return generated.findings.map((finding) => groundRequirement(finding, validFeatureIds));
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new RequirementsReviewValidationError(err.zodError);
    }
    throw err;
  }
}