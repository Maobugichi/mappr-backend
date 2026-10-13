import { z } from 'zod';
import { Type } from '@google/genai';

// Deliberately small — Features, Tech Stack, Architecture, Roadmap, and
// the cross-references to other generated artifacts are all assembled
// in code from data already in the map (see readmeRender.ts). Only
// these two sections have no existing equivalent to draw from.
const GettingStartedStepSchema = z.object({
  description: z.string(),
  // Not every step reduces to a literal command (e.g. "set up a
  // Postgres database and get a connection string") — null when there
  // isn't one, same "nullable, not optional" convention used
  // throughout this project since relationalSchema.ts.
  command: z.string().nullable(),
});

export const GeneratedReadmeSchema = z.object({
  overview: z.string(),
  gettingStarted: z.array(GettingStartedStepSchema),
});

export type GettingStartedStep = z.infer<typeof GettingStartedStepSchema>;
export type GeneratedReadme = z.infer<typeof GeneratedReadmeSchema>;

// Tied to map version, same convention as api_contracts/relational_schemas
// (not the ADR's hash-based approach — a README draws on features and
// the dev plan too, which the ADR's narrower techStack+architecture
// hash deliberately excludes).
export const ReadmeRecordSchema = z.object({
  mapId: z.string(),
  version: z.number().int(),
  overview: z.string(),
  gettingStarted: z.array(GettingStartedStepSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ReadmeRecord = z.infer<typeof ReadmeRecordSchema>;

const geminiStepSchema = {
  type: Type.OBJECT,
  properties: {
    description: { type: Type.STRING },
    command: { type: Type.STRING, nullable: true },
  },
  required: ['description', 'command'],
};

export const geminiReadmeResponseSchema = {
  type: Type.OBJECT,
  properties: {
    overview: { type: Type.STRING },
    gettingStarted: { type: Type.ARRAY, items: geminiStepSchema },
  },
  required: ['overview', 'gettingStarted'],
};