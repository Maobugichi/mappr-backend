import { z } from 'zod';
import { Type } from '@google/genai';

// bsonType-adjacent logical types — not a 1:1 mirror of
// relationalSchema.ts's LOGICAL_TYPES, since document databases have no
// real DDL types to stay agnostic across (there's one renderer, not
// three), so these map close to MongoDB's actual bsonType vocabulary.
// 'object' and 'array' are real types here, unlike relational, because
// embedding IS how this model represents nested/related data.
const LOGICAL_TYPES = [
  'objectId',
  'string',
  'integer',
  'bigint',
  'decimal',
  'boolean',
  'datetime',
  'date',
  'object',
  'array',
  'enum',
] as const;

export type DocumentLogicalType = (typeof LOGICAL_TYPES)[number];

const RELATION_KINDS = ['embed', 'reference'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

// Mirrors the "always nullable, never optional" approach from
// relationalSchema.ts — this is also a new schema, so there's no
// existing Gemini behavior to stay tolerant of.
const FieldRelationSchema = z.object({
  kind: z.enum(RELATION_KINDS),
  targetEntityId: z.string(), // must reference dataModel.entities[].id
});

const DocumentFieldSchema = z.object({
  name: z.string(),
  type: z.enum(LOGICAL_TYPES),
  required: z.boolean(),
  // Only meaningful when type === 'enum'; null otherwise.
  enumValues: z.array(z.string()).nullable(),
  // Set when this field embeds another entity's data (type should be
  // 'object' for one, 'array' for many) or holds a reference to another
  // entity's _id (type should be 'objectId' for one, 'array' for many).
  // Null for a plain scalar field with no relation to another entity.
  relation: FieldRelationSchema.nullable(),
});

export const DocumentCollectionSchema = z.object({
  entityId: z.string(), // must reference dataModel.entities[].id
  collectionName: z.string(), // snake_case
  fields: z.array(DocumentFieldSchema),
});

export const GeneratedDocumentSchema = z.object({
  collections: z.array(DocumentCollectionSchema),
});

export type DocumentField = z.infer<typeof DocumentFieldSchema>;
export type DocumentCollection = z.infer<typeof DocumentCollectionSchema>;
export type GeneratedDocument = z.infer<typeof GeneratedDocumentSchema>;

// Tied to one map version, same convention as RelationalSchemaRecord.
// `collections` here includes the synthesized many-to-many reference
// fields the service adds after grounding (see documentSchema.ts's
// synthesizeManyToManyReferences) — the stored artifact is complete,
// not just the AI's raw output.
export const DocumentSchemaRecordSchema = z.object({
  mapId: z.string(),
  version: z.number().int(),
  collections: z.array(DocumentCollectionSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DocumentSchemaRecord = z.infer<typeof DocumentSchemaRecordSchema>;

const geminiFieldSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    type: { type: Type.STRING, enum: [...LOGICAL_TYPES] },
    required: { type: Type.BOOLEAN },
    enumValues: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING },
    },
    relation: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        kind: { type: Type.STRING, enum: [...RELATION_KINDS] },
        targetEntityId: { type: Type.STRING },
      },
      required: ['kind', 'targetEntityId'],
    },
  },
  required: ['name', 'type', 'required', 'enumValues', 'relation'],
};

export const geminiDocumentResponseSchema = {
  type: Type.OBJECT,
  properties: {
    collections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          entityId: { type: Type.STRING },
          collectionName: { type: Type.STRING },
          fields: { type: Type.ARRAY, items: geminiFieldSchema },
        },
        required: ['entityId', 'collectionName', 'fields'],
      },
    },
  },
  required: ['collections'],
};