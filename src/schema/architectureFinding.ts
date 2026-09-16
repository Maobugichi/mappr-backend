import { z } from 'zod';
import { Type } from '@google/genai';

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const CategorySchema = z.enum([
  'architecture',
  'security',
  'scalability',
  'performance',
  'reliability',
  'maintainability',
  'data',
  'observability',
  'cost',
  'developer_experience',
]);

export const ObservationTypeSchema = z.enum(['observed', 'inferred', 'recommended']);

// Shape Gemini is asked to produce. No `id`/`dismissed` here — those are
// assigned server-side once the response has been validated, so nothing
// AI-generated ends up as a primary/dismissal key.
export const GeneratedFindingSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: SeveritySchema,
  category: CategorySchema,
  observationType: ObservationTypeSchema,
  affectedNodeIds: z.array(z.string()),
  recommendation: z.string(),
});

export const GeneratedReviewSchema = z.object({
  findings: z.array(GeneratedFindingSchema),
});

export type GeneratedFinding = z.infer<typeof GeneratedFindingSchema>;
export type GeneratedReview = z.infer<typeof GeneratedReviewSchema>;

// Persisted/returned shape: generated finding + server-assigned id + dismissed flag.
export const ArchitectureFindingSchema = GeneratedFindingSchema.extend({
  id: z.string(),
  dismissed: z.boolean(),
});

export const ArchitectureReviewSchema = z.object({
  mapId: z.string(),
  findings: z.array(ArchitectureFindingSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ArchitectureFinding = z.infer<typeof ArchitectureFindingSchema>;
export type ArchitectureReview = z.infer<typeof ArchitectureReviewSchema>;

export const geminiFindingResponseSchema = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ['low', 'medium', 'high', 'critical'] },
          category: {
            type: Type.STRING,
            enum: [
              'architecture',
              'security',
              'scalability',
              'performance',
              'reliability',
              'maintainability',
              'data',
              'observability',
              'cost',
              'developer_experience',
            ],
          },
          observationType: {
            type: Type.STRING,
            enum: ['observed', 'inferred', 'recommended'],
          },
          affectedNodeIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          recommendation: { type: Type.STRING },
        },
        required: [
          'title',
          'description',
          'severity',
          'category',
          'observationType',
          'affectedNodeIds',
          'recommendation',
        ],
      },
    },
  },
  required: ['findings'],
};