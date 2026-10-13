import { z } from 'zod';
import { Type } from '@google/genai';

// Logical, dialect-agnostic types only — never real SQL syntax. Code
// renders these to Postgres/MySQL/SQLite text in relationalRender.ts;
// the AI never writes a dialect-specific type or statement.
const LOGICAL_TYPES = [
  'uuid',
  'string',
  'text',
  'integer',
  'bigint',
  'decimal',
  'boolean',
  'datetime',
  'date',
  'json',
  'enum',
] as const;

export type LogicalType = (typeof LOGICAL_TYPES)[number];

// Unlike the earlier four features' retrofitted .optional() fields,
// this schema is new — so every field that can have "no value" is
// .nullable() (required key, explicit null) from the start, on both
// the Gemini and Groq sides. No Gemini-can-omit-it tolerance needed,
// since there's no existing Gemini behavior to stay compatible with.
const ColumnReferenceSchema = z.object({
  table: z.string(), // the referenced table's tableName, not its entityId
  column: z.string(),
});

const RelationalColumnSchema = z.object({
  name: z.string(),
  type: z.enum(LOGICAL_TYPES),
  nullable: z.boolean(), // whether the COLUMN allows NULL — unrelated to this schema's own .nullable() usage
  primaryKey: z.boolean(),
  references: ColumnReferenceSchema.nullable(),
  // Only meaningful when type === 'enum'; null otherwise.
  enumValues: z.array(z.string()).nullable(),
});

export const RelationalTableSchema = z.object({
  entityId: z.string(), // must reference dataModel.entities[].id
  tableName: z.string(), // snake_case
  columns: z.array(RelationalColumnSchema),
});

export const GeneratedRelationalSchema = z.object({
  tables: z.array(RelationalTableSchema),
});

export type RelationalColumn = z.infer<typeof RelationalColumnSchema>;
export type RelationalTable = z.infer<typeof RelationalTableSchema>;
export type GeneratedRelational = z.infer<typeof GeneratedRelationalSchema>;

// A relational schema is tied to one map version, same convention as
// ApiContractSchema. `tables` here includes synthesized many-to-many
// join tables (added by the service after grounding, not by the AI) —
// the stored artifact is the complete set, not just the AI's output.
export const RelationalSchemaRecordSchema = z.object({
  mapId: z.string(),
  version: z.number().int(),
  tables: z.array(RelationalTableSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RelationalSchemaRecord = z.infer<typeof RelationalSchemaRecordSchema>;

const geminiColumnSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    type: { type: Type.STRING, enum: [...LOGICAL_TYPES] },
    nullable: { type: Type.BOOLEAN },
    primaryKey: { type: Type.BOOLEAN },
    references: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        table: { type: Type.STRING },
        column: { type: Type.STRING },
      },
      required: ['table', 'column'],
    },
    enumValues: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING },
    },
  },
  required: ['name', 'type', 'nullable', 'primaryKey', 'references', 'enumValues'],
};

export const geminiRelationalResponseSchema = {
  type: Type.OBJECT,
  properties: {
    tables: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          entityId: { type: Type.STRING },
          tableName: { type: Type.STRING },
          columns: { type: Type.ARRAY, items: geminiColumnSchema },
        },
        required: ['entityId', 'tableName', 'columns'],
      },
    },
  },
  required: ['tables'],
};