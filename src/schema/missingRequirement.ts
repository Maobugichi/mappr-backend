import { z } from 'zod';
import { Type } from '@google/genai';

export const RequirementSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const RequirementCategorySchema = z.enum([
  'auth',
  'data_integrity',
  'error_handling',
  'compliance',
  'notifications',
  'edge_case',
  'non_functional',
  'other',
]);

// Shape Gemini is asked to produce. No `id`/`dismissed` here — those are
// assigned server-side after validation, same convention as
// architectureFinding.ts.
export const GeneratedRequirementSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: RequirementSeveritySchema,
  category: RequirementCategorySchema,
  // Existing feature ids this gap relates to (e.g. "password reset" is a
  // gap adjacent to an existing "User Login" feature). Can be empty for
  // a gap that isn't adjacent to anything currently in the system.
  relatedFeatureIds: z.array(z.string()),
  suggestedFeature: z.object({
    name: z.string(),
    description: z.string(),
  }),
});

export const GeneratedRequirementsReviewSchema = z.object({
  findings: z.array(GeneratedRequirementSchema),
});

export type GeneratedRequirement = z.infer<typeof GeneratedRequirementSchema>;
export type GeneratedRequirementsReview = z.infer<typeof GeneratedRequirementsReviewSchema>;

export const MissingRequirementSchema = GeneratedRequirementSchema.extend({
  id: z.string(),
  dismissed: z.boolean(),
});

export const RequirementsReviewSchema = z.object({
  mapId: z.string(),
  findings: z.array(MissingRequirementSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MissingRequirement = z.infer<typeof MissingRequirementSchema>;
export type RequirementsReview = z.infer<typeof RequirementsReviewSchema>;

export const geminiRequirementResponseSchema = {
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
              'auth',
              'data_integrity',
              'error_handling',
              'compliance',
              'notifications',
              'edge_case',
              'non_functional',
              'other',
            ],
          },
          relatedFeatureIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          suggestedFeature: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ['name', 'description'],
          },
        },
        required: [
          'title',
          'description',
          'severity',
          'category',
          'relatedFeatureIds',
          'suggestedFeature',
        ],
      },
    },
  },
  required: ['findings'],
};