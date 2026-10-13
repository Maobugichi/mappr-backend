import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import {
  geminiDocumentResponseSchema,
  GeneratedDocumentSchema,
  type DocumentCollection,
  type DocumentField,
} from '../schema/documentSchema.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are designing a MongoDB-style document schema for a system, grounded in its data model. You will be given the system's entities and relations as JSON.

For each entity, produce exactly one collection:
- entityId must exactly match one of the given entities' id.
- collectionName is a snake_case name for the collection (e.g. "users", "order_items").
- Every field in the entity becomes a field on the collection's document. Use your own judgment to assign the most appropriate logical type (objectId, string, integer, bigint, decimal, boolean, datetime, date, object, array, enum) based on the field's name and the entity's purpose — the entity's own field "type" string is a hint, not a literal instruction.
- Set "required" based on whether the field is genuinely mandatory in this domain.
- Set "enumValues" only when type is "enum"; null otherwise.
- For each one-to-one or one-to-many relation given, decide, on the appropriate side of that relation, whether to EMBED the related data directly in the document or REFERENCE it by id in a separate collection:
  - Prefer embedding when the related data is naturally small and bounded, tightly owned by the parent, and rarely queried on its own (e.g. a user's few shipping addresses).
  - Prefer referencing when the related data is unbounded, grows over time, is queried independently, or is shared across multiple parents (e.g. a user's orders, which can grow without limit and are often queried on their own).
  - Set "relation" on the field that embeds or references it: {kind: "embed"|"reference", targetEntityId: <the other entity's id>}. The field's type should be "object" for a single embed, "array" for an embedded list, "objectId" for a single reference, or "array" for a list of references.
  - Leave "relation" null for a field with no connection to another entity.
- Do not address many-to-many relations at all — those are added automatically, outside of what you produce. This includes an entity that is ITSELF clearly a junction connecting two other entities (e.g. its only fields are id-like references to two other entities, with no relation naming it directly) — still tag its own fields with "relation": {kind: "reference", ...} pointing at the entities they reference, exactly as you would for any other reference field.

Rules:
- Use real entity ids only.
- Do not invent fields unrelated to the entity's given fields.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nData model:\n"""\n${JSON.stringify(system.dataModel)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class DocumentSchemaValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Drops collections not grounded to a real entity, and nulls out
// (rather than drops) any relation pointing at an entity that didn't
// survive that filtering — same pattern as relationalSchema.ts's
// groundTables, except relation targets here are entity ids, not
// generated collection names, since the AI never invents those.
function groundCollections(
  collections: DocumentCollection[],
  validEntityIds: Set<string>
): DocumentCollection[] {
  const grounded = collections.filter((c) => validEntityIds.has(c.entityId));
  const survivingEntityIds = new Set(grounded.map((c) => c.entityId));

  return grounded.map((collection) => ({
    ...collection,
    fields: collection.fields.map((field) => ({
      ...field,
      relation:
        field.relation && survivingEntityIds.has(field.relation.targetEntityId) ? field.relation : null,
    })),
  }));
}

// Same reasoning as relationalSchema.ts's hasExistingJunctionTable —
// true when some OTHER collection already has reference fields to both
// sides of the relation, meaning the data model already represents
// this many-to-many as its own explicit entity. A self-referential
// relation needs two separate reference fields to that same entity to
// count, not just one.
function hasExistingJunctionCollection(
  collections: DocumentCollection[],
  fromEntityId: string,
  toEntityId: string
): boolean {
  return collections.some((collection) => {
    if (collection.entityId === fromEntityId || collection.entityId === toEntityId) return false;
    const refCounts = new Map<string, number>();
    for (const field of collection.fields) {
      if (!field.relation) continue;
      refCounts.set(
        field.relation.targetEntityId,
        (refCounts.get(field.relation.targetEntityId) ?? 0) + 1
      );
    }
    if (fromEntityId === toEntityId) {
      return (refCounts.get(fromEntityId) ?? 0) >= 2;
    }
    return (refCounts.get(fromEntityId) ?? 0) >= 1 && (refCounts.get(toEntityId) ?? 0) >= 1;
 });
}



// Many-to-many relations are never embedded (embedding doesn't scale on
// either side of one), so unlike one-to-one/one-to-many they're not
// left to the AI at all — a reference field is added to both sides
// here, mechanically, once both collections are known.
function synthesizeManyToManyReferences(
  collections: DocumentCollection[],
  system: MapprSystem
): DocumentCollection[] {
  const byEntityId = new Map(collections.map((c) => [c.entityId, c]));
  const extraFields = new Map<string, DocumentField[]>(); // keyed by entityId

  function addField(entityId: string, field: DocumentField) {
    const existing = extraFields.get(entityId) ?? [];
    existing.push(field);
    extraFields.set(entityId, existing);
  }

  function uniqueName(entityId: string, desired: string): string {
    const taken = new Set([
      ...byEntityId.get(entityId)!.fields.map((f) => f.name),
      ...(extraFields.get(entityId) ?? []).map((f) => f.name),
    ]);
    let name = desired;
    while (taken.has(name)) name += '_link';
    return name;
  }

  for (const relation of system.dataModel.relations) {
    if (relation.type !== 'many-to-many') continue;

    const fromCollection = byEntityId.get(relation.from);
    const toCollection = byEntityId.get(relation.to);
    if (!fromCollection || !toCollection) continue; 
    if (hasExistingJunctionCollection(collections, relation.from, relation.to)) continue; // already modeled as its own entity
    

    // A self-referential relation (e.g. users "following" other users)
    // has relation.from === relation.to — the plain `${entityId}_ids`
    // naming below would then collide on the same collection, same
    // reasoning as relationalSchema.ts's from_/to_ prefix fix.
    const selfReferential = relation.from === relation.to;
    const fromFieldDesired = selfReferential ? `to_${relation.to}_ids` : `${relation.to}_ids`;
    const toFieldDesired = selfReferential ? `from_${relation.from}_ids` : `${relation.from}_ids`;

    addField(relation.from, {
      name: uniqueName(relation.from, fromFieldDesired),
      type: 'array',
      required: false,
      enumValues: null,
      relation: { kind: 'reference', targetEntityId: relation.to },
    });
    addField(relation.to, {
      name: uniqueName(relation.to, toFieldDesired),
      type: 'array',
      required: false,
      enumValues: null,
      relation: { kind: 'reference', targetEntityId: relation.from },
    });
  }

  return collections.map((collection) => ({
    ...collection,
    fields: [...collection.fields, ...(extraFields.get(collection.entityId) ?? [])],
  }));
}

export async function generateDocumentSchema(system: MapprSystem): Promise<DocumentCollection[]> {
  const validEntityIds = new Set(system.dataModel.entities.map((e) => e.id));

  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedDocumentSchema,
      geminiResponseSchema: geminiDocumentResponseSchema,
      groqSchemaName: 'document_schema',
    });
    const grounded = groundCollections(generated.collections, validEntityIds);
    return synthesizeManyToManyReferences(grounded, system);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new DocumentSchemaValidationError(err.zodError);
    }
    throw err;
  }
}