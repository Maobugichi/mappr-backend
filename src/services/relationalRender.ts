import type { LogicalType, RelationalColumn, RelationalTable } from '../schema/relationalSchema.js';

export const RELATIONAL_DIALECTS = ['postgres', 'mysql', 'sqlite'] as const;
export type RelationalDialect = (typeof RELATIONAL_DIALECTS)[number];

// Logical type -> dialect SQL type. Enum columns are rendered as a
// plain string type plus a CHECK constraint in every dialect, rather
// than Postgres's native CREATE TYPE ... AS ENUM or MySQL's native
// ENUM(...) column type — one rendering path for all three, and it
// also sidesteps CREATE TYPE statement ordering entirely. Decimal
// precision/scale and string length aren't part of the logical type
// (the AI isn't asked for them), so sizes below are reasonable
// defaults, not generated values.
const TYPE_MAP: Record<RelationalDialect, Record<LogicalType, string>> = {
  postgres: {
    uuid: 'uuid',
    string: 'varchar(255)',
    text: 'text',
    integer: 'integer',
    bigint: 'bigint',
    decimal: 'numeric(12,2)',
    boolean: 'boolean',
    datetime: 'timestamptz',
    date: 'date',
    json: 'jsonb',
    enum: 'varchar(255)',
  },
  mysql: {
    uuid: 'char(36)',
    string: 'varchar(255)',
    text: 'text',
    integer: 'int',
    bigint: 'bigint',
    decimal: 'decimal(12,2)',
    boolean: 'boolean',
    datetime: 'datetime',
    date: 'date',
    json: 'json',
    enum: 'varchar(255)',
  },
  sqlite: {
    // SQLite has storage classes, not fixed column types — these are
    // the type affinities that make it store/compare values sanely.
    uuid: 'text',
    string: 'text',
    text: 'text',
    integer: 'integer',
    bigint: 'integer',
    decimal: 'numeric',
    boolean: 'integer',
    datetime: 'text',
    date: 'text',
    json: 'text',
    enum: 'text',
  },
};

function quoteIdentifier(name: string, dialect: RelationalDialect): string {
  return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

function quoteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function renderColumnDefinition(column: RelationalColumn, dialect: RelationalDialect): string {
  const parts = [quoteIdentifier(column.name, dialect), TYPE_MAP[dialect][column.type]];

  // A primary-key column is NOT NULL by definition — enforced here
  // regardless of the stored `nullable` value, in case the AI's output
  // disagreed with itself.
  if (!column.nullable || column.primaryKey) {
    parts.push('NOT NULL');
  }

  if (column.type === 'enum' && column.enumValues && column.enumValues.length > 0) {
    const values = column.enumValues.map(quoteStringLiteral).join(', ');
    parts.push(`CHECK (${quoteIdentifier(column.name, dialect)} IN (${values}))`);
  }

  return parts.join(' ');
}

// A table "depends on" every table its columns reference — it must be
// created after each of those, since SQLite has no ALTER TABLE ... ADD
// CONSTRAINT, so foreign keys can only be expressed inline (creation
// order therefore matters in every dialect, not just SQLite).
function dependencyEdges(tables: RelationalTable[]): Map<string, Set<string>> {
  const names = new Set(tables.map((t) => t.tableName));
  const edges = new Map<string, Set<string>>(tables.map((t) => [t.tableName, new Set<string>()]));
  for (const table of tables) {
    for (const column of table.columns) {
      const ref = column.references?.table;
      if (ref && ref !== table.tableName && names.has(ref)) {
        edges.get(table.tableName)!.add(ref);
      }
    }
  }
  return edges;
}

// Tarjan's SCC algorithm. A strongly-connected component with more than
// one table is a genuine reference cycle. This matters because a naive
// "topological sort, whatever's left over is cyclic" approach (an
// earlier version of this function) incorrectly also flags tables that
// merely depend on something inside a cycle — e.g. an `orders` table
// that only points at `users` would get swept in by that approach even
// though `orders` itself isn't part of any cycle. SCCs identify exactly
// the tables genuinely involved in a cycle, and nothing else.
function stronglyConnectedComponents(edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const v of edges.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }

  return components;
}

// Returns every table in creation order, plus the set of "table.column"
// foreign keys to omit from rendering — exactly the edges that sit
// inside a genuine reference cycle, nothing downstream of one.
function resolveCreateOrder(
  tables: RelationalTable[]
): { ordered: RelationalTable[]; skipReferences: Set<string>; notes: string[] } {
  const byName = new Map(tables.map((t) => [t.tableName, t]));
  const edges = dependencyEdges(tables);

  const cyclicTables = new Set<string>();
  for (const component of stronglyConnectedComponents(edges)) {
    if (component.length > 1) {
      for (const name of component) cyclicTables.add(name);
    }
  }

  const skipReferences = new Set<string>();
  const notes: string[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      const ref = column.references?.table;
      if (ref && cyclicTables.has(table.tableName) && cyclicTables.has(ref)) {
        skipReferences.add(`${table.tableName}.${column.name}`);
        notes.push(
          `-- NOTE: ${table.tableName}.${column.name} -> ${ref}.${column.references!.column} omitted (circular reference between tables)`
        );
      }
    }
  }

  // With cycle-internal edges removed, the dependency graph is
  // guaranteed acyclic, so a plain Kahn's algorithm now resolves every
  // table — no leftover "cyclic" bucket needed.
  const effectiveEdges = new Map(
    tables.map((t) => [
      t.tableName,
      new Set([...(edges.get(t.tableName) ?? [])].filter((ref) => !cyclicTables.has(t.tableName) || !cyclicTables.has(ref))),
    ])
  );
  const inDegree = new Map(tables.map((t) => [t.tableName, effectiveEdges.get(t.tableName)!.size]));
  const dependents = new Map<string, string[]>(tables.map((t) => [t.tableName, []]));
  for (const [name, refs] of effectiveEdges) {
    for (const ref of refs) dependents.get(ref)!.push(name);
  }

  const queue = tables.filter((t) => inDegree.get(t.tableName) === 0).map((t) => t.tableName);
  const ordered: RelationalTable[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    ordered.push(byName.get(name)!);
    for (const dependent of dependents.get(name) ?? []) {
      const remaining = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  return { ordered, skipReferences, notes };
}

function renderCreateTable(
  table: RelationalTable,
  dialect: RelationalDialect,
  // Foreign keys to omit from this CREATE TABLE because they're part of
  // a reference cycle — handled separately by the caller.
  skipReferences: Set<string>
): string {
  const lines = table.columns.map((c) => '  ' + renderColumnDefinition(c, dialect));

  const primaryKeyColumns = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (primaryKeyColumns.length > 0) {
    const cols = primaryKeyColumns.map((name) => quoteIdentifier(name, dialect)).join(', ');
    lines.push(`  PRIMARY KEY (${cols})`);
  }

  for (const column of table.columns) {
    if (!column.references || skipReferences.has(`${table.tableName}.${column.name}`)) continue;
    const refTable = quoteIdentifier(column.references.table, dialect);
    const refColumn = quoteIdentifier(column.references.column, dialect);
    lines.push(
      `  FOREIGN KEY (${quoteIdentifier(column.name, dialect)}) REFERENCES ${refTable} (${refColumn})`
    );
  }

  return `CREATE TABLE ${quoteIdentifier(table.tableName, dialect)} (\n${lines.join(',\n')}\n);`;
}

export function renderRelationalSchema(tables: RelationalTable[], dialect: RelationalDialect): string {
  // Tables inside a genuine reference cycle still get created, just
  // without the specific foreign key(s) that form the cycle —
  // Postgres/MySQL could express those via a trailing ALTER TABLE
  // instead, but SQLite has no equivalent, so the same (documented)
  // omission is used for all three dialects rather than three
  // different behaviors for an already-rare case.
  const { ordered, skipReferences, notes } = resolveCreateOrder(tables);
  const statements = ordered.map((table) => renderCreateTable(table, dialect, skipReferences));
  return [...notes, ...statements].join('\n\n');
}