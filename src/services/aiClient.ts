import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { z, type ZodError, type ZodType } from 'zod';
import { aiRetryDelay, throwIfCancelled, withAISignal } from './aiCancellation.js';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is not set');
}
if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is not set');
}

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Fallback chain, fastest/cheapest first. Only models Groq currently
// supports for strict-mode (constrained decoding) structured outputs —
// see https://console.groq.com/docs/structured-outputs#supported-models.
// Gemini stays primary; this chain is only walked once Gemini itself
// has exhausted its own transient retries and its own two-attempt
// validate/retry-with-error-context pass.
const GROQ_FALLBACK_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'] as const;

const TRANSIENT_RETRY_DELAYS_MS = [1000, 3000];

// Groq's default completion cap is too low for the larger structured
// outputs (a full /generate system map), and the gpt-oss models spend
// part of the same budget on reasoning tokens. Explicit cap kept under
// the 8000 tokens-per-minute limit seen on this account's rate-limit
// headers, so prompt + completion can still fit in one request.
const GROQ_MAX_COMPLETION_TOKENS = 6000;

// Compact one-line description of a provider error for logs — the
// full SDK error object includes headers and, for Groq, the entire
// truncated generation.
function describeError(err: unknown): string {
  const status = (err as { status?: number } | undefined)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return `${status ?? 'no status'} ${message.slice(0, 400)}`;
}

function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 503 || status === 429;
}

// Thrown once every provider in the chain has had its fair attempt.
// zodError is set when the last attempt produced parseable-but-invalid
// JSON (a real schema mismatch); it's undefined when the last attempt
// failed on a transient connectivity error instead. Each service's own
// wrapper inspects zodError to decide whether to rethrow its existing
// named *ValidationError class (preserving current route behavior) or
// let a plain failure propagate.
export class AIGenerationError extends Error {
  zodError?: ZodError;

  constructor(message: string, zodError?: ZodError) {
    super(message);
    this.zodError = zodError;
  }
}


function errorSummaryFrom(zodError: ZodError): string {
  return zodError.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
}


async function callWithTransientRetry(
  call: (prompt: string) => Promise<unknown>,
  prompt: string,
  signal?: AbortSignal
): Promise<unknown> {
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      throwIfCancelled(signal);
      const output = await withAISignal(call(prompt), signal);
      throwIfCancelled(signal);
      return output;
    } catch (err) {
      throwIfCancelled(signal);
      const isLastAttempt = attempt === TRANSIENT_RETRY_DELAYS_MS.length;
      if (!isTransientError(err) || isLastAttempt) {
        throw err;
      }
      await aiRetryDelay(TRANSIENT_RETRY_DELAYS_MS[attempt], signal);
    }
  }

  throw new Error('callWithTransientRetry exhausted attempts unexpectedly');
}


function forceRequiredForStrictMode(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(forceRequiredForStrictMode);
  }
  if (schema && typeof schema === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      result[key] = forceRequiredForStrictMode(value);
    }
    if (result.type === 'object' && result.properties && typeof result.properties === 'object') {
      result.required = Object.keys(result.properties as Record<string, unknown>);
      result.additionalProperties = false;
    }
    return result;
  }
  return schema;
}


async function validateWithOneRetry<T>(
  buildPrompt: (retryContext?: string) => string,
  call: (prompt: string) => Promise<unknown>,
  zodSchema: ZodType<T>,
  signal?: AbortSignal
): Promise<{ success: true; data: T } | { success: false; error: ZodError }> {
  throwIfCancelled(signal);
  const firstAttempt = await callWithTransientRetry(call, buildPrompt(), signal);
  const firstResult = zodSchema.safeParse(firstAttempt);
  if (firstResult.success) {
    return { success: true, data: firstResult.data };
  }

  const secondAttempt = await callWithTransientRetry(
    call,
    buildPrompt(errorSummaryFrom(firstResult.error)), signal
  );
  const secondResult = zodSchema.safeParse(secondAttempt);
  if (secondResult.success) {
    return { success: true, data: secondResult.data };
  }

  return { success: false, error: secondResult.error };
}

async function callGemini(prompt: string, geminiResponseSchema: object, signal?: AbortSignal): Promise<unknown> {
  throwIfCancelled(signal);
  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema,
      ...(signal ? { abortSignal: signal, httpOptions: { retryOptions: { attempts: 1 } } } : {}),
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Gemini response had no text content');
  }

  return JSON.parse(text);
}

async function callGroq(
  prompt: string,
  model: string,
  groqSchema: Record<string, unknown>,
  schemaName: string,
  signal?: AbortSignal
): Promise<unknown> {
  throwIfCancelled(signal);
  const response = await groq.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
    ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' as const } : {}),
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema: groqSchema },
    },
  }, signal ? { signal, maxRetries: 0 } : undefined);

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error(`Groq (${model}) response had no text content`);
  }

  return JSON.parse(text);
}

export interface GenerateStructuredConfig<T> {
  // Opt-in for bounded previews; legacy callers retain SDK defaults/logging.
  signal?: AbortSignal;
  redactErrors?: boolean;
  // Same signature every service's existing buildPrompt already has —
  // called with no args for the first attempt, and with an error
  // summary string to retry the same provider once.
  buildPrompt: (retryContext?: string) => string;
  zodSchema: ZodType<T>;
  // Existing Type-based schema each service already builds for Gemini
  // — unchanged, passed straight through.
  geminiResponseSchema: object;
  // Short identifier for Groq's response_format.json_schema.name, e.g.
  // "architecture_review".
  groqSchemaName: string;
}

export async function generateStructured<T>(config: GenerateStructuredConfig<T>): Promise<T> {
  throwIfCancelled(config.signal);
  const { buildPrompt, zodSchema, geminiResponseSchema, groqSchemaName } = config;

  // Derived from the zod schema, then normalized so every object lists
  // all its properties as required with additionalProperties: false
  // (Groq strict mode). Fields that can be absent are .nullable() in
  // the zod schemas, so they can still express "no value" as null.
  const groqSchema = forceRequiredForStrictMode(z.toJSONSchema(zodSchema)) as Record<string, unknown>;

  let lastValidationError: ZodError | undefined;

  try {
    const result = await validateWithOneRetry(
      buildPrompt,
      (prompt) => callGemini(prompt, geminiResponseSchema, config.signal),
      zodSchema, config.signal
    );
    if (result.success) {
      return result.data;
    }
    lastValidationError = result.error;
    if (config.redactErrors) console.error('[aiClient] Gemini output rejected');
    else console.error(`[aiClient] Gemini (${GEMINI_MODEL}) returned invalid output:`, result.error.issues);
  } catch (err) {
    throwIfCancelled(config.signal);
    if (config.redactErrors) console.error('[aiClient] Gemini request failed');
    else console.error(`[aiClient] Gemini (${GEMINI_MODEL}) failed: ${describeError(err)}`);
  }

  for (const model of GROQ_FALLBACK_MODELS) {
    throwIfCancelled(config.signal);
    try {
      const result = await validateWithOneRetry(
        buildPrompt,
        (prompt) => callGroq(prompt, model, groqSchema, groqSchemaName, config.signal),
        zodSchema, config.signal
      );
      if (result.success) {
        return result.data;
      }
      lastValidationError = result.error;
      if (config.redactErrors) console.error('[aiClient] Groq output rejected');
      else console.error(`[aiClient] Groq (${model}) returned invalid output:`, result.error.issues);
    } catch (err) {
      throwIfCancelled(config.signal);
      if (config.redactErrors) console.error('[aiClient] Groq request failed');
      else console.error(`[aiClient] Groq (${model}) failed: ${describeError(err)}`);
    }
  }

  throw new AIGenerationError(
    'AI response failed schema validation or was unreachable across Gemini and all Groq fallback models',
    lastValidationError
  );
}
