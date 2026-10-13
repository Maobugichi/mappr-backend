import { z } from 'zod';
import { Type } from '@google/genai';

// One environment variable. `nodeId` and `techStackCategory` are the
// grounding links — the same "point at something real in the map"
// approach as every other AI-backed feature here. Both are nullable
// (required key, explicit null), following the convention used since
// relationalSchema.ts: null means "not tied to one", e.g. PORT belongs
// to no particular tech-stack item, and a shared variable belongs to no
// single architecture node.
const EnvVarSchema = z.object({
  // UPPER_SNAKE_CASE. Not enforced with a regex here — keeping pattern
  // constraints out of the schema Groq's strict mode has to accept —
  // so the service normalizes and validates it in code instead.
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
  // Secrets (API keys, passwords, connection strings with credentials)
  // vs plain config (PORT, NODE_ENV). Rendered with a marker so the
  // difference is visible in the .env.example itself.
  secret: z.boolean(),
  // An obviously-fake example value. Never a realistic-looking secret.
  placeholder: z.string(),
  // The architecture node that consumes this variable. Must reference
  // architecture.nodes[].id; null for shared/global config.
  nodeId: z.string().nullable(),
  // The tech-stack item this variable is for. Must reference
  // techStack[].category; null when there isn't one.
  techStackCategory: z.string().nullable(),
});

export const GeneratedEnvVarsSchema = z.object({
  vars: z.array(EnvVarSchema),
});

export type EnvVar = z.infer<typeof EnvVarSchema>;
export type GeneratedEnvVars = z.infer<typeof GeneratedEnvVarsSchema>;

// Keyed by the same techStack+architecture hash as ADRs (see adr.ts's
// techArchHash), not by map version — a new database or service changes
// the variables a system needs, but adding a feature or editing the
// data model normally doesn't.
export const EnvVarSetRecordSchema = z.object({
  mapId: z.string(),
  techArchHash: z.string(),
  vars: z.array(EnvVarSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EnvVarSetRecord = z.infer<typeof EnvVarSetRecordSchema>;

export const geminiEnvVarsResponseSchema = {
  type: Type.OBJECT,
  properties: {
    vars: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          required: { type: Type.BOOLEAN },
          secret: { type: Type.BOOLEAN },
          placeholder: { type: Type.STRING },
          nodeId: { type: Type.STRING, nullable: true },
          techStackCategory: { type: Type.STRING, nullable: true },
        },
        required: [
          'name',
          'description',
          'required',
          'secret',
          'placeholder',
          'nodeId',
          'techStackCategory',
        ],
      },
    },
  },
  required: ['vars'],
};