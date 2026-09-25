import type { MapprSystem } from '../schema/mapprSystem.js';

// Generic diff of two arrays matched by a stable key (id, category,
// token, name, etc.) — items present in both are compared field-by-field
// for the given fields; a shallow JSON.stringify comparison per field is
// enough to catch changes without needing a deep diff library. Nested
// arrays inside a compared field (e.g. an entity's `fields`) are treated
// as "changed" as a whole rather than diffed field-by-field themselves —
// that's a deliberate scope limit, not an oversight: pinpointing exactly
// which nested field changed adds real complexity for marginal display
// value in v1.
export type ArrayDiff<T> = {
  added: T[];
  removed: T[];
  changed: { before: T; after: T; changedFields: string[] }[];
};

function diffByKey<T, K>(
  oldArr: T[],
  newArr: T[],
  keyFn: (item: T) => K,
  fieldsToCompare: (keyof T)[]
): ArrayDiff<T> {
  const oldByKey = new Map(oldArr.map((item) => [keyFn(item), item]));
  const newByKey = new Map(newArr.map((item) => [keyFn(item), item]));

  const added: T[] = [];
  const removed: T[] = [];
  const changed: { before: T; after: T; changedFields: string[] }[] = [];

  for (const [key, newItem] of newByKey) {
    const oldItem = oldByKey.get(key);
    if (!oldItem) {
      added.push(newItem);
      continue;
    }
    const changedFields = fieldsToCompare
      .filter((field) => JSON.stringify(oldItem[field]) !== JSON.stringify(newItem[field]))
      .map((field) => String(field));
    if (changedFields.length > 0) {
      changed.push({ before: oldItem, after: newItem, changedFields });
    }
  }

  for (const [key, oldItem] of oldByKey) {
    if (!newByKey.has(key)) removed.push(oldItem);
  }

  return { added, removed, changed };
}

// For arrays with no stable key (edges, relations, plan items, concept
// strings) — matched by full deep equality instead. No "changed" bucket
// here: a modified edge/relation just looks like one removed + one
// added, which is the correct read for something with no identity of
// its own.
export type SimpleArrayDiff<T> = { added: T[]; removed: T[] };

function diffByDeepEquality<T>(oldArr: T[], newArr: T[]): SimpleArrayDiff<T> {
  const oldSet = new Set(oldArr.map((item) => JSON.stringify(item)));
  const newSet = new Set(newArr.map((item) => JSON.stringify(item)));

  return {
    added: newArr.filter((item) => !oldSet.has(JSON.stringify(item))),
    removed: oldArr.filter((item) => !newSet.has(JSON.stringify(item))),
  };
}

export type FieldDiff = { field: string; before: unknown; after: unknown };

function diffFields<T extends object>(
  before: T,
  after: T,
  fields: (keyof T)[]
): FieldDiff[] {
  return fields
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field: String(field), before: before[field], after: after[field] }));
}

type DevelopmentPlanPhase = MapprSystem['developmentPlan'][number];

function diffDevelopmentPlan(
  oldPlan: DevelopmentPlanPhase[],
  newPlan: DevelopmentPlanPhase[]
): {
  added: DevelopmentPlanPhase[];
  removed: DevelopmentPlanPhase[];
  changed: {
    phase: number;
    titleChanged: boolean;
    items: SimpleArrayDiff<DevelopmentPlanPhase['items'][number]>;
  }[];
} {
  const oldByPhase = new Map(oldPlan.map((p) => [p.phase, p]));
  const newByPhase = new Map(newPlan.map((p) => [p.phase, p]));

  const added: DevelopmentPlanPhase[] = [];
  const removed: DevelopmentPlanPhase[] = [];
  const changed: {
    phase: number;
    titleChanged: boolean;
    items: SimpleArrayDiff<DevelopmentPlanPhase['items'][number]>;
  }[] = [];

  for (const [phaseNum, newPhase] of newByPhase) {
    const oldPhase = oldByPhase.get(phaseNum);
    if (!oldPhase) {
      added.push(newPhase);
      continue;
    }
    const titleChanged = oldPhase.title !== newPhase.title;
    const items = diffByDeepEquality(oldPhase.items, newPhase.items);
    if (titleChanged || items.added.length > 0 || items.removed.length > 0) {
      changed.push({ phase: phaseNum, titleChanged, items });
    }
  }

  for (const [phaseNum, oldPhase] of oldByPhase) {
    if (!newByPhase.has(phaseNum)) removed.push(oldPhase);
  }

  return { added, removed, changed };
}

export type SystemDiff = {
  meta: FieldDiff[];
  product: {
    summary: FieldDiff[];
    concepts: SimpleArrayDiff<string>;
  };
  users: ArrayDiff<MapprSystem['users'][number]>;
  features: ArrayDiff<MapprSystem['features'][number]>;
  techStack: ArrayDiff<MapprSystem['techStack'][number]>;
  architecture: {
    nodes: ArrayDiff<MapprSystem['architecture']['nodes'][number]>;
    edges: SimpleArrayDiff<MapprSystem['architecture']['edges'][number]>;
  };
  dataModel: {
    entities: ArrayDiff<MapprSystem['dataModel']['entities'][number]>;
    relations: SimpleArrayDiff<MapprSystem['dataModel']['relations'][number]>;
  };
  designSystem: {
    colors: ArrayDiff<MapprSystem['designSystem']['colors'][number]>;
    typography: ArrayDiff<MapprSystem['designSystem']['typography'][number]>;
    spacing: ArrayDiff<MapprSystem['designSystem']['spacing'][number]>;
    components: ArrayDiff<MapprSystem['designSystem']['components'][number]>;
  };
  developmentPlan: ReturnType<typeof diffDevelopmentPlan>;
  hasChanges: boolean;
};

function arrayDiffIsEmpty(d: ArrayDiff<unknown> | SimpleArrayDiff<unknown>): boolean {
  const hasChanged = 'changed' in d ? d.changed.length > 0 : false;
  return d.added.length === 0 && d.removed.length === 0 && !hasChanged;
}

export function computeSystemDiff(oldSystem: MapprSystem, newSystem: MapprSystem): SystemDiff {
  const meta = diffFields(oldSystem.meta, newSystem.meta, ['productName', 'oneLineSummary']);
  const productSummary = diffFields(oldSystem.product, newSystem.product, ['summary']);
  const concepts = diffByDeepEquality(oldSystem.product.concepts, newSystem.product.concepts);

  const users = diffByKey(oldSystem.users, newSystem.users, (u) => u.id, [
    'name',
    'description',
  ]);

  const features = diffByKey(oldSystem.features, newSystem.features, (f) => f.id, [
    'name',
    'description',
    'relatedUsers',
    'dependsOn',
  ]);

  const techStack = diffByKey(oldSystem.techStack, newSystem.techStack, (t) => t.category, [
    'choice',
    'rationale',
  ]);

  const architectureNodes = diffByKey(
    oldSystem.architecture.nodes,
    newSystem.architecture.nodes,
    (n) => n.id,
    ['label', 'type', 'description']
  );
  const architectureEdges = diffByDeepEquality(
    oldSystem.architecture.edges,
    newSystem.architecture.edges
  );

  const dataModelEntities = diffByKey(
    oldSystem.dataModel.entities,
    newSystem.dataModel.entities,
    (e) => e.id,
    ['name', 'fields']
  );
  const dataModelRelations = diffByDeepEquality(
    oldSystem.dataModel.relations,
    newSystem.dataModel.relations
  );

  const designSystem = {
    colors: diffByKey(
      oldSystem.designSystem.colors,
      newSystem.designSystem.colors,
      (t) => t.token,
      ['value']
    ),
    typography: diffByKey(
      oldSystem.designSystem.typography,
      newSystem.designSystem.typography,
      (t) => t.token,
      ['value']
    ),
    spacing: diffByKey(
      oldSystem.designSystem.spacing,
      newSystem.designSystem.spacing,
      (t) => t.token,
      ['value']
    ),
    components: diffByKey(
      oldSystem.designSystem.components,
      newSystem.designSystem.components,
      (c) => c.name,
      ['description']
    ),
  };

  const developmentPlan = diffDevelopmentPlan(
    oldSystem.developmentPlan,
    newSystem.developmentPlan
  );

  const hasChanges =
    meta.length > 0 ||
    productSummary.length > 0 ||
    !arrayDiffIsEmpty(concepts) ||
    !arrayDiffIsEmpty(users) ||
    !arrayDiffIsEmpty(features) ||
    !arrayDiffIsEmpty(techStack) ||
    !arrayDiffIsEmpty(architectureNodes) ||
    !arrayDiffIsEmpty(architectureEdges) ||
    !arrayDiffIsEmpty(dataModelEntities) ||
    !arrayDiffIsEmpty(dataModelRelations) ||
    !arrayDiffIsEmpty(designSystem.colors) ||
    !arrayDiffIsEmpty(designSystem.typography) ||
    !arrayDiffIsEmpty(designSystem.spacing) ||
    !arrayDiffIsEmpty(designSystem.components) ||
    developmentPlan.added.length > 0 ||
    developmentPlan.removed.length > 0 ||
    developmentPlan.changed.length > 0;

  return {
    meta,
    product: { summary: productSummary, concepts },
    users,
    features,
    techStack,
    architecture: { nodes: architectureNodes, edges: architectureEdges },
    dataModel: { entities: dataModelEntities, relations: dataModelRelations },
    designSystem,
    developmentPlan,
    hasChanges,
  };
}