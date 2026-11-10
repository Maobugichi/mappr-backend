// Pure preparation only: no database, filesystem, environment, AI, or logging.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { MapprSystemSchema } from '../../src/schema/mapprSystem.ts';
import { isUuid } from '../../src/middleware/anonSession.ts';

export class ReconciliationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ReconciliationError(code); };
const own = (value,key) => value !== null && typeof value === 'object' && Object.hasOwn(value,key);
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const meaning = 'no_relationships_recorded_in_legacy_source';

function at(value,path) { for (const part of path) value = value?.[part]; return value; }
function set(value,path,replacement) { const parent=at(value,path.slice(0,-1)); parent[path.at(-1)]=replacement; }

export function normalizeLegacyTasks(data) {
  const parsed=MapprSystemSchema.safeParse(data);
  if (!parsed.success && parsed.error.issues.some(issue => {
    const p=issue.path;
    const legacy=p.length===4 && p[0]==='developmentPlan' && Number.isInteger(p[1]) && p[2]==='items'
      && Number.isInteger(p[3]) && issue.code==='invalid_type' && typeof at(data,p)==='string';
    const description=p.length===4 && p[0]==='architecture' && p[1]==='nodes' && Number.isInteger(p[2])
      && p[3]==='description' && issue.code==='invalid_type' && !own(at(data,p.slice(0,-1)),'description');
    return !legacy && !description;
  })) fail('unrecognized_source_shape');
  const candidate=structuredClone(data),changes=[];
  candidate.developmentPlan.forEach((phase,pi) => {
    phase.items=phase.items.map((item,ii) => {
      if (typeof item!=='string') return item;
      changes.push({kind:'wrap_legacy_task',path:['developmentPlan',pi,'items',ii],beforeType:'string',afterType:'object',
        afterFields:['description','relatedFeatures'],textPreserved:true,recordedReferences:0});
      return {description:item,relatedFeatures:[]};
    });
  });
  if (!verifyUnchangedNonTargets(data,candidate,changes)) fail('non_target_change');
  return {candidate,changes,wrappedTasks:changes.length,nonTargetPreserved:true,
    currentSchemaValid:MapprSystemSchema.safeParse(candidate).success};
}

// Revert only the declared target changes, then compare every other parsed JSON
// value structurally. SQL later must patch exact JSONB paths, not reserialize
// an entire payload (which could change unrelated JSON numeric representation).
export function verifyUnchangedNonTargets(source,candidate,changes) {
  const restored=structuredClone(candidate);
  for (const change of changes) {
    if (change.kind==='wrap_legacy_task') {
      const value=at(candidate,change.path),original=at(source,change.path);
      if (typeof original!=='string' || !isDeepStrictEqual(value,{description:original,relatedFeatures:[]})) return false;
      set(restored,change.path,original);
    } else if (change.kind==='set_missing_description') {
      if (own(at(source,change.path.slice(0,-1)),'description')) return false;
      delete at(restored,change.path.slice(0,-1))[change.path.at(-1)];
    } else return false;
  }
  return isDeepStrictEqual(source,restored);
}

export function sourceFingerprint(source,targetFingerprint) {
  if (!fingerprintSchema.safeParse(targetFingerprint).success || !isUuid(source.mapId) || !isUuid(source.ownerId)
    || typeof source.dataJsonbText!=='string') fail('invalid_source_metadata');
  let parsed;
  try { parsed=JSON.parse(source.dataJsonbText); } catch { fail('invalid_source_metadata'); }
  if (!isDeepStrictEqual(parsed,source.data)) fail('source_capture_mismatch');
  // Includes exact server-returned JSONB text, owner and target, but none of
  // these private values is printed by this module or exposed in its errors.
  return hash(JSON.stringify([targetFingerprint,source.mapId,source.ownerId,source.dataJsonbText]));
}

function unique(items,key) {
  const keys=items.map(key);
  if (new Set(keys).size!==keys.length) fail('duplicate_target');
}
function affectedSources(sources,targetFingerprint) {
  unique(sources,source=>source.mapId.toLowerCase());
  return sources.map(source => {
    const fingerprint=sourceFingerprint(source,targetFingerprint);
    const normalized=normalizeLegacyTasks(source.data);
    const missing=source.data.architecture.nodes.map((node,index)=>({node,index})).filter(({node})=>!own(node,'description'));
    if (missing.length) {
      unique(source.data.architecture.nodes,node=>node.id);
      if (source.data.architecture.nodes.some(node=>!node.id)) fail('ambiguous_node_reference');
    }
    return {source,fingerprint,normalized,missing};
  }).filter(item=>item.normalized.changes.length || item.missing.length);
}
function nodeContext(data,node) {
  const byId=new Map(data.architecture.nodes.map(item=>[item.id,item]));
  const relationships=[];
  for (const edge of data.architecture.edges) {
    if (edge.from!==node.id && edge.to!==node.id) continue;
    const direction=edge.from===node.id?'outgoing':'incoming';
    const otherNodeId=direction==='outgoing'?edge.to:edge.from;
    const other=byId.get(otherNodeId);
    relationships.push({direction,otherNodeId,otherLabel:other?.label??null,otherType:other?.type??null,edgeLabel:edge.label??null});
  }
  return {nodeId:node.id,label:node.label,type:node.type,relationships};
}

export function buildReconciliationReview(sources,targetFingerprint) {
  const affected=affectedSources(sources,targetFingerprint);
  return {formatVersion:1,targetFingerprint,taskPolicy:{meaning,approved:false},
    sources:affected.map(({source,fingerprint,normalized})=>({mapId:source.mapId,sourceFingerprint:fingerprint,taskChanges:normalized.changes})),
    architecture:affected.filter(item=>item.missing.length).map(({source,missing})=>({mapId:source.mapId,nodes:missing.map(({node})=>({
      ...nodeContext(source.data,node),suggestedDescription:'',suggestionState:'manual_entry_required',
      proposedDescription:'',descriptionOrigin:'new_proposed_content',approved:false,
    }))}))};
}

const pathSchema=z.array(z.union([z.string(),z.number().int().nonnegative()]));
const changeSchema=z.strictObject({kind:z.literal('wrap_legacy_task'),path:pathSchema,beforeType:z.literal('string'),afterType:z.literal('object'),
  afterFields:z.tuple([z.literal('description'),z.literal('relatedFeatures')]),textPreserved:z.literal(true),recordedReferences:z.literal(0)});
const nodeSchema=z.strictObject({nodeId:z.string().min(1),label:z.string(),type:z.string(),relationships:z.array(z.strictObject({
  direction:z.enum(['incoming','outgoing']),otherNodeId:z.string(),otherLabel:z.string().nullable(),otherType:z.string().nullable(),edgeLabel:z.string().nullable(),
})),suggestedDescription:z.literal(''),suggestionState:z.literal('manual_entry_required'),proposedDescription:z.string(),
  descriptionOrigin:z.literal('new_proposed_content'),approved:z.boolean()});
const packetSchema=z.strictObject({formatVersion:z.literal(1),targetFingerprint:fingerprintSchema,
  taskPolicy:z.strictObject({meaning:z.literal(meaning),approved:z.boolean()}),
  sources:z.array(z.strictObject({mapId:z.string(),sourceFingerprint:fingerprintSchema,taskChanges:z.array(changeSchema)})),
  architecture:z.array(z.strictObject({mapId:z.string(),nodes:z.array(nodeSchema)}))});

export function parseReconciliationReview(packet) {
  const parsed=packetSchema.safeParse(packet);
  if (!parsed.success) fail('invalid_review_packet');
  return parsed.data;
}

// Returns private, in-memory candidates only. It does not authorize execution,
// grant edit access, prove who approved, save files, or obtain a DB connection.
export function validateReconciliationReview(sources,packet,targetFingerprint) {
  const review=parseReconciliationReview(packet);
  if (review.targetFingerprint!==targetFingerprint) fail('target_mismatch');
  unique(review.sources,item=>item.mapId.toLowerCase());
  unique(review.architecture,item=>item.mapId.toLowerCase());
  for (const item of review.architecture) unique(item.nodes,node=>node.nodeId);
  const expected=buildReconciliationReview(sources,targetFingerprint);
  if (!review.taskPolicy.approved) fail('task_policy_approval_required');
  if (!isDeepStrictEqual(review.sources,expected.sources)) fail('stale_or_unknown_source');
  if (review.architecture.length!==expected.architecture.length) fail('incomplete_or_unknown_targets');
  for (let i=0;i<expected.architecture.length;i++) {
    const actual=review.architecture[i],required=expected.architecture[i];
    if (actual.mapId!==required.mapId || actual.nodes.length!==required.nodes.length) fail('incomplete_or_unknown_targets');
    for (let j=0;j<required.nodes.length;j++) {
      const {proposedDescription,approved,...context}=actual.nodes[j];
      const {proposedDescription:unusedText,approved:unusedApproval,...requiredContext}=required.nodes[j];
      if (!isDeepStrictEqual(context,requiredContext)) fail('stale_or_unknown_node');
      if (!approved) fail('description_approval_required');
      const text=proposedDescription.trim();
      if (!text || text===context.nodeId || text===context.label.trim()) fail('invalid_description');
    }
  }
  const affected=affectedSources(sources,targetFingerprint);
  return affected.map(({source,fingerprint,normalized,missing})=>{
    const candidate=normalized.candidate,changes=[...normalized.changes];
    if (missing.length) {
      const descriptions=review.architecture.find(item=>item.mapId===source.mapId).nodes;
      for (const {node,index} of missing) {
        candidate.architecture.nodes[index].description=descriptions.find(item=>item.nodeId===node.id).proposedDescription;
        changes.push({kind:'set_missing_description',path:['architecture','nodes',index,'description'],beforeType:'missing',afterType:'string'});
      }
    }
    if (!MapprSystemSchema.safeParse(candidate).success) fail('candidate_invalid');
    if (!verifyUnchangedNonTargets(source.data,candidate,changes)) fail('non_target_change');
    return {mapId:source.mapId,sourceFingerprint:fingerprint,candidate,changes,nonTargetPreserved:true};
  });
}
