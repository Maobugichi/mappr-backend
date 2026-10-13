import { z } from 'zod';
import { Type } from '@google/genai';

// What an ADR is explaining. tech_stack grounds against a
// techStack[].category (TechStackItemSchema has no id field, so
// category is the best available natural key). architecture_node and
// architecture_edge ground against real architecture.nodes[].id and a
// real {from,to} pair respectively.
const SUBJECT_TYPES = ['tech_stack', 'architecture_node', 'architecture_edge'] as const;
export type AdrSubjectType = (typeof SUBJECT_TYPES)[number];

// No optional or nullable fields anywhere in this schema — unlike the
// relational/document schemas, there was nothing here that needed to
// express "no value" (an ADR with no alternatives is just an empty
// array, not a missing field), so none of that complexity applies.
const AlternativeSchema = z.object({
  option: z.string(),
  reasonRejected: z.string(),
});

export const AdrSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  // For tech_stack: the techStack item's category. For
  // architecture_node: the node's id. For architecture_edge: formatted
  // as "fromId:toId" matching a real edge.
  subjectId: z.string(),
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  alternatives: z.array(AlternativeSchema),
  consequences: z.array(z.string()),
});

export const GeneratedAdrSchema = z.object({
  adrs: z.array(AdrSchema),
});

export type Adr = z.infer<typeof AdrSchema>;
export type GeneratedAdr = z.infer<typeof GeneratedAdrSchema>;

// Keyed by a hash of techStack + architecture (see adr.ts's
// techArchHash), not by map version — an iteration that only touches
// dataModel or features shouldn't invalidate ADRs that have nothing to
// do with either of those.
export const AdrSetRecordSchema = z.object({
  mapId: z.string(),
  techArchHash: z.string(),
  adrs: z.array(AdrSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AdrSetRecord = z.infer<typeof AdrSetRecordSchema>;

const geminiAlternativeSchema = {
  type: Type.OBJECT,
  properties: {
    option: { type: Type.STRING },
    reasonRejected: { type: Type.STRING },
  },
  required: ['option', 'reasonRejected'],
};

export const geminiAdrResponseSchema = {
  type: Type.OBJECT,
  properties: {
    adrs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          subjectType: { type: Type.STRING, enum: [...SUBJECT_TYPES] },
          subjectId: { type: Type.STRING },
          title: { type: Type.STRING },
          context: { type: Type.STRING },
          decision: { type: Type.STRING },
          alternatives: { type: Type.ARRAY, items: geminiAlternativeSchema },
          consequences: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['subjectType', 'subjectId', 'title', 'context', 'decision', 'alternatives', 'consequences'],
      },
    },
  },
  required: ['adrs'],
};