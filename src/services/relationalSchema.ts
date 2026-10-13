import type { ZodError } from 'zod';
import { AIGenerationError, generateStructured } from './aiClient.js';
import {
  geminiRelationalResponseSchema,
  GeneratedRelationalSchema,
  type RelationalTable,
} from '../schema/relationalSchema.js';
import type { MapprSystem } from '../schema/mapprSystem.js';

const SYSTEM_INSTRUCTIONS = `You are designing a relational database schema for a system, grounded in its data model. You will be given the system's entities and relations as JSON.

For each entity, produce exactly one table:
- entityId must exactly match one of the given entities' id.
- tableName is a snake_case name for the table (e.g. "users", "order_items").
- Every field in the entity becomes a column. Use your own judgment to assign the most appropriate logical type (uuid, string, text, integer, bigint, decimal, boolean, datetime, date, json, enum) based on the field's name and the entity's purpose — the entity's own field "type" string is a hint, not a literal instruction. For example a field typed "uuid FK" should become a uuid column with primaryKey: false and references set to the entity it points at.
- Mark primaryKey: true on whichever column (usually a field literally named "id") uniquely identifies a row. Every table must have at least one primary key column.
- Set "nullable" based on whether the field is genuinely optional in this domain.
- Set "references" to {table, column} when a column is a foreign key — "table" must be the OTHER entity's tableName (not its entityId), and "column" its primary key column's name. Use the given relations (one-to-one / one-to-many) and field names together to decide this. Set references to null for columns that aren't foreign keys.
- Set "enumValues" only when type is "enum" (a short fixed set of values this domain clearly implies); null otherwise.
- Do not create a table for a many-to-many relation — those become join tables automatically, outside of what you produce. Just make sure the entities on each end of a one-to-one or one-to-many relation have a column referencing the other, where that makes sense.

Rules:
- Use real entity ids only.
- Do not invent columns unrelated to the entity's given fields, beyond a primary key if the fields don't already include one.`;

function buildPrompt(system: MapprSystem, retryContext?: string): string {
  let prompt = `${SYSTEM_INSTRUCTIONS}\n\nData model:\n"""\n${JSON.stringify(system.dataModel)}\n"""\n\nRespond with ONLY the JSON object.`;

  if (retryContext) {
    prompt += `\n\nYour previous response failed schema validation with these errors:\n${retryContext}\n\nFix the response and try again. Respond with ONLY the corrected JSON object.`;
  }

  return prompt;
}

export class RelationalSchemaValidationError extends Error {
  zodError: ZodError;

  constructor(zodError: ZodError) {
    super('AI response failed schema validation after retry');
    this.zodError = zodError;
  }
}

// Drops tables not grounded to a real entity, and nulls out (rather
// than drops) any reference pointing at a table that didn't survive
// that filtering — same "null the dangling part, keep the rest"
// pattern as groundContract's id filtering.
function groundTables(tables: RelationalTable[], validEntityIds: Set<string>): RelationalTable[] {
  const grounded = tables.filter((t) => validEntityIds.has(t.entityId));
  const validTableNames = new Set(grounded.map((t) => t.tableName));

  return grounded.map((table) => ({
    ...table,
    columns: table.columns.map((column) => ({
      ...column,
      references:
        column.references && validTableNames.has(column.references.table) ? column.references : null,
    })),
  }));
}

// True when some OTHER table already has foreign keys to both sides of
// the relation — meaning the data model already represents this
// many-to-many as its own explicit entity (e.g. a "post_tag" entity
// alongside a separate post<->tag many-to-many relation), and the AI
// already turned it into a real table with real references. Without
// this check, that table and a freshly synthesized one would both
// exist, duplicating the same relationship. For a self-referential
// relation (fromTableName === toTableName), a single FK to that table
// isn't enough to count — it takes two (e.g. follower_id AND
// followee_id) to actually serve as a self-join.
function hasExistingJunctionTable(
  tables: RelationalTable[],
  fromTableName: string,
  toTableName: string
): boolean {
  return tables.some((table) => {
    if (table.tableName === fromTableName || table.tableName === toTableName) return false;
    const refCounts = new Map<string, number>();
    for (const column of table.columns) {
      if (!column.references) continue;
      refCounts.set(column.references.table, (refCounts.get(column.references.table) ?? 0) + 1);
    }
    if (fromTableName === toTableName) {
      return (refCounts.get(fromTableName) ?? 0) >= 2;
    }
    return (refCounts.get(fromTableName) ?? 0) >= 1 && (refCounts.get(toTableName) ?? 0) >= 1;
  });
}

 // Many-to-many relations have no entity of their own — the join table
// Many-to-many relations have no entity of their own — the join table
// is fully mechanical once both sides' tables and primary keys are
// known, so it's synthesized here rather than asked of the AI (keeps
// the generated output smaller, and there's nothing to reason about).
function synthesizeJoinTables(tables: RelationalTable[], system: MapprSystem): RelationalTable[] {
  const byEntityId = new Map(tables.map((t) => [t.entityId, t]));
  const usedNames = new Set(tables.map((t) => t.tableName));
  const joinTables: RelationalTable[] = [];

  for (const relation of system.dataModel.relations) {
    if (relation.type !== 'many-to-many') continue;

    const fromTable = byEntityId.get(relation.from);
    const toTable = byEntityId.get(relation.to);
    if (!fromTable || !toTable) continue; // relation points at an entity whose table didn't survive grounding
    if (hasExistingJunctionTable(tables, fromTable.tableName, toTable.tableName)) continue; 
    const fromKeys = fromTable.columns.filter((c) => c.primaryKey);
    const toKeys = toTable.columns.filter((c) => c.primaryKey);
    if (fromKeys.length === 0 || toKeys.length === 0) continue; // can't build a valid FK without a known primary key

    let joinName = `${fromTable.tableName}_${toTable.tableName}`;
    while (usedNames.has(joinName)) joinName += '_link';
    usedNames.add(joinName);

    // A self-referential many-to-many relation (e.g. users "following"
    // other users) has relation.from === relation.to, so the plain
    // `${entityId}_${pk.name}` naming below would collide — both sides
    // would produce the same column name. The from_/to_ prefix is only
    // added in that case, so the common cross-entity case stays as
    // clean as `user_id` / `tag_id`.
    const selfReferential = relation.from === relation.to;
    const fromPrefix = selfReferential ? `from_${relation.from}` : relation.from;
    const toPrefix = selfReferential ? `to_${relation.to}` : relation.to;

    joinTables.push({
      entityId: joinName, // synthesized — not a real entity id, only used so this table carries an id like any other
      tableName: joinName,
      columns: [
        ...fromKeys.map((pk) => ({
          name: `${fromPrefix}_${pk.name}`,
          type: pk.type,
          nullable: false,
          primaryKey: true,
          references: { table: fromTable.tableName, column: pk.name },
          enumValues: null,
        })),
        ...toKeys.map((pk) => ({
          name: `${toPrefix}_${pk.name}`,
          type: pk.type,
          nullable: false,
          primaryKey: true,
          references: { table: toTable.tableName, column: pk.name },
          enumValues: null,
        })),
      ],
    });
  }

  return [...tables, ...joinTables];
}

export async function generateRelationalSchema(system: MapprSystem): Promise<RelationalTable[]> {
  const validEntityIds = new Set(system.dataModel.entities.map((e) => e.id));

  try {
    const generated = await generateStructured({
      buildPrompt: (retryContext) => buildPrompt(system, retryContext),
      zodSchema: GeneratedRelationalSchema,
      geminiResponseSchema: geminiRelationalResponseSchema,
      groqSchemaName: 'relational_schema',
    });
    const grounded = groundTables(generated.tables, validEntityIds);
    return synthesizeJoinTables(grounded, system);
  } catch (err) {
    if (err instanceof AIGenerationError && err.zodError) {
      throw new RelationalSchemaValidationError(err.zodError);
    }
    throw err;
  }
}