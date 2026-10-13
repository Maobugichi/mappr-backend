import type { DocumentCollection, DocumentField, DocumentLogicalType } from '../schema/documentSchema.js';

// Logical type -> MongoDB bsonType. Only one target here (unlike
// relationalRender.ts's three dialects), so this is a straight mapping
// rather than a Record<Dialect, ...>.
const BSON_TYPE: Record<DocumentLogicalType, string> = {
  objectId: 'objectId',
  string: 'string',
  integer: 'int',
  bigint: 'long',
  decimal: 'decimal',
  boolean: 'bool',
  datetime: 'date',
  date: 'date',
  object: 'object',
  array: 'array',
  enum: 'string',
};

type JsonSchemaProperty = Record<string, unknown>;

function fieldToPropertySchema(field: DocumentField): JsonSchemaProperty {
  const property: JsonSchemaProperty = { bsonType: BSON_TYPE[field.type] };

  if (field.type === 'enum' && field.enumValues && field.enumValues.length > 0) {
    property.enum = field.enumValues;
  }

  if (field.relation) {
    // The validator only constrains bsonType, not the full shape of an
    // embedded document or the collection a reference points into —
    // same "no item-level detail" simplification used for array fields
    // in the API contract renderer, kept here as a comment instead of
    // enforced structure, so the generated validator doesn't have to
    // duplicate every related entity's full field list inline.
    property.description =
      field.relation.kind === 'embed'
        ? `Embeds ${field.relation.targetEntityId} (${field.type === 'array' ? 'array of embedded documents' : 'single embedded document'}) — shape not enforced here.`
        : `References ${field.relation.targetEntityId}'s _id (${field.type === 'array' ? 'array of ObjectIds' : 'single ObjectId'}).`;

    if (field.relation.kind === 'reference' && field.type === 'array') {
      property.items = { bsonType: 'objectId' };
    }
  }

  return property;
}

function collectionToValidator(collection: DocumentCollection): JsonSchemaProperty {
  // Mongo gives every document an automatic _id: ObjectId — a field in
  // the generated output literally named "id" is treated as that same
  // identity rather than kept as a second, redundant id-like field.
  // Everything else renders exactly as the AI specified it.
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const field of collection.fields) {
    const key = field.name === 'id' ? '_id' : field.name;
    properties[key] = fieldToPropertySchema(field);
    if (field.required) required.push(key);
  }

  return {
    bsonType: 'object',
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

export function renderDocumentSchema(collections: DocumentCollection[]): string {
  const statements = collections.map((collection) => {
    const validator = { $jsonSchema: collectionToValidator(collection) };
    return `db.createCollection(${JSON.stringify(collection.collectionName)}, {\n  validator: ${JSON.stringify(validator, null, 2).split('\n').join('\n  ')}\n});`;
  });

  return statements.join('\n\n');
}