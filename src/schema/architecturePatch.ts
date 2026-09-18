import { z } from 'zod';
import { Type } from '@google/genai';

// Scoped to architecture.nodes/architecture.edges for v1 — broader
// modification (features, data model, tech stack) is a natural
// extension later but would blur into what Missing Requirements
// already covers; keeping this the smallest coherent version.

const NewArchitectureNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  description: z.string(),
});

const UpdateArchitectureNodeSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
});

const NewArchitectureEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});

// Edges have no id in the current data model (see mapprSystem.ts), so
// removal matches by from/to — label narrows the match when there are
// multiple edges between the same pair of nodes; omitted, it removes
// all edges between that pair.
const RemoveArchitectureEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});

export const ArchitecturePatchSchema = z.object({
  addNodes: z.array(NewArchitectureNodeSchema),
  removeNodeIds: z.array(z.string()),
  updateNodes: z.array(UpdateArchitectureNodeSchema),
  addEdges: z.array(NewArchitectureEdgeSchema),
  removeEdges: z.array(RemoveArchitectureEdgeSchema),
});

export type ArchitecturePatch = z.infer<typeof ArchitecturePatchSchema>;

export const GeneratedIterationSchema = z.object({
  summary: z.string(),
  patch: ArchitecturePatchSchema,
});

export type GeneratedIteration = z.infer<typeof GeneratedIterationSchema>;

export const IterationResultSchema = z.object({
  mapId: z.string(),
  version: z.number().int().positive(),
  summary: z.string(),
  patch: ArchitecturePatchSchema,
  data: z.unknown(), // the full MapprSystem — typed as MapprSystem at the call site
  createdAt: z.string(),
});

export type IterationResult = z.infer<typeof IterationResultSchema>;

export const VersionSummarySchema = z.object({
  version: z.number().int().positive(),
  summary: z.string(),
  createdAt: z.string(),
});

export type VersionSummary = z.infer<typeof VersionSummarySchema>;

export const geminiIterationResponseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    patch: {
      type: Type.OBJECT,
      properties: {
        addNodes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              label: { type: Type.STRING },
              type: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ['id', 'label', 'type', 'description'],
          },
        },
        removeNodeIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        updateNodes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              label: { type: Type.STRING },
              type: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ['id'],
          },
        },
        addEdges: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING },
              to: { type: Type.STRING },
              label: { type: Type.STRING },
            },
            required: ['from', 'to'],
          },
        },
        removeEdges: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING },
              to: { type: Type.STRING },
              label: { type: Type.STRING },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['addNodes', 'removeNodeIds', 'updateNodes', 'addEdges', 'removeEdges'],
    },
  },
  required: ['summary', 'patch'],
};