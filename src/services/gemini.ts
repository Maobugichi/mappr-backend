import { GoogleGenAI } from '@google/genai';
import type { ZodError } from 'zod';
import { geminiResponseSchema } from '../schema/geminiResponseSchema.js';
import { MapprSystemSchema, type MapprSystem } from '../schema/mapprSystem.js';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not set');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

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

async function callGemini(prompt: string): Promise<unknown> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema,
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

export class GenerationValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('Gemini response failed schema validation after retry');
    this.zodError = zodError;
  }
}


export async function generateMapprSystem(description: string): Promise<MapprSystem> {
  const firstAttempt = await callGeminiWithRetry(buildPrompt(description));
  const firstResult = MapprSystemSchema.safeParse(firstAttempt);
  if (firstResult.success) {
    return firstResult.data;
  }

  const errorSummary = firstResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  const secondAttempt = await callGeminiWithRetry(buildPrompt(description, errorSummary));
  const secondResult = MapprSystemSchema.safeParse(secondAttempt);
  if (secondResult.success) {
    return secondResult.data;
  }

  throw new GenerationValidationError(secondResult.error);
}