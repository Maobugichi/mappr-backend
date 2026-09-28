import { z } from 'zod';
import { Type } from '@google/genai';

export const TraceLinkSchema = z.object({
  featureId: z.string(),
  nodeIds: z.array(z.string()),
  note: z.string().nullable().optional(),
});

export const GeneratedTraceabilitySchema = z.object({
  links: z.array(TraceLinkSchema),
});

export type TraceLink = z.infer<typeof TraceLinkSchema>;
export type GeneratedTraceability = z.infer<typeof GeneratedTraceabilitySchema>;

export const TraceabilityReviewSchema = z.object({
  mapId: z.string(),
  links: z.array(TraceLinkSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TraceabilityReview = z.infer<typeof TraceabilityReviewSchema>;

export const geminiTraceabilityResponseSchema = {
  type: Type.OBJECT,
  properties: {
    links: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          featureId: { type: Type.STRING },
          nodeIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          note: { type: Type.STRING },
        },
        required: ['featureId', 'nodeIds'],
      },
    },
  },
  required: ['links'],
};