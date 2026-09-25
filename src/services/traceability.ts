import { GoogleGenAI } from '@google/genai';
import type { ZodError } from 'zod';
import {
  geminiTraceabilityResponseSchema,
  GeneratedTraceabilitySchema,
  type TraceLink,
} from '../schema/traceability.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not set');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

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

async function callGemini(prompt: string): Promise<unknown> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: geminiTraceabilityResponseSchema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Gemini response had no text content');
  }

  return JSON.parse(text);
}

const TRANSIENT_RETRY_DELAYS_MS = [1000, 3000];

function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 503 || status === 429;
}

async function callGeminiWithRetry(prompt: string): Promise<unknown> {
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await callGemini(prompt);
    } catch (err) {
      const isLastAttempt = attempt === TRANSIENT_RETRY_DELAYS_MS.length;
      if (!isTransientError(err) || isLastAttempt) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
    }
  }

  throw new Error('callGeminiWithRetry exhausted attempts unexpectedly');
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
    .map((link) => ({
      ...link,
      nodeIds: link.nodeIds.filter((id) => validNodeIds.has(id)),
    }));
}

export async function generateTraceability(system: MapprSystem): Promise<TraceLink[]> {
  const validFeatureIds = new Set(system.features.map((f) => f.id));
  const validNodeIds = new Set(system.architecture.nodes.map((n) => n.id));

  const firstAttempt = await callGeminiWithRetry(buildPrompt(system));
  const firstResult = GeneratedTraceabilitySchema.safeParse(firstAttempt);
  if (firstResult.success) {
    return groundLinks(firstResult.data.links, validFeatureIds, validNodeIds);
  }

  const errorSummary = firstResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  const secondAttempt = await callGeminiWithRetry(buildPrompt(system, errorSummary));
  const secondResult = GeneratedTraceabilitySchema.safeParse(secondAttempt);
  if (secondResult.success) {
    return groundLinks(secondResult.data.links, validFeatureIds, validNodeIds);
  }

  throw new TraceabilityValidationError(secondResult.error);
}