// One-use operator engine. No configured pool, dotenv, filesystem, AI or logging.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseOperatorConfig,assertOperatorRequest,verifyTarget,inspectSchema,CutoverError } from '../../src/db/s3bCutover.ts';
import { revisionTransaction } from '../../src/db/revisionTransaction.ts';
import { MapprSystemSchema } from '../../src/schema/mapprSystem.ts';
import { parseReconciliationReview,validateReconciliationReview,sourceFingerprint,verifyUnchangedNonTargets,ReconciliationError } from './s3b-reconciliation.mjs';

export class ExecutorError extends Error {
  constructor(code,progress) { super(code);this.code=code;this.progress={...progress}; }
}
const fail=code=>{throw new ReconciliationError(code);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source=row=>({mapId:row.mapId,ownerId:row.ownerId,data:JSON.parse(row.dataJsonbText),dataJsonbText:row.dataJsonbText});
const rowFields='id AS "mapId",anon_id AS "ownerId",data,data::text AS "dataJsonbText",input_description AS "inputDescription",created_at::text AS "createdAt",updated_at::text AS "updatedAt"';

export function assertReconciliationRequest(input,mode,confirmation,packet) {
  const config=parseOperatorConfig(input),review=parseReconciliationReview(packet);
  if (!config.expectedTargetFingerprint || review.targetFingerprint!==config.expectedTargetFingerprint) fail('target_mismatch');
  if (!['validate','execute'].includes(mode)) fail('invalid_mode');
  if (mode==='execute') {
    if (confirmation!=='AUTHORIZE_S3B_RECONCILIATION_WRITE') fail('execution_not_approved');
    assertOperatorRequest(config,'backfill','AUTHORIZE_S3B_DEVELOPMENT_WRITE');
  } else if (confirmation!==undefined) fail('invalid_confirmation');
  if (!review.taskPolicy.approved) fail('task_policy_approval_required');
  if (review.architecture.some(map=>map.nodes.some(node=>!node.approved))) fail('description_approval_required');
  if (review.sources.length!==13 || review.architecture.length!==3 || review.architecture.reduce((n,map)=>n+map.nodes.length,0)!==25
    || review.sources.reduce((n,map)=>n+map.taskChanges.length,0)!==131) fail('unexpected_reconciliation_scope');
  return {config,review};
}

const evidenceRow=z.strictObject({mapId:z.string(),ownerId:z.string(),dataJsonbText:z.string(),inputDescription:z.string(),createdAt:z.string(),updatedAt:z.string()});
const evidenceSchema=z.strictObject({formatVersion:z.literal(1),targetFingerprint:z.string(),reviewDigest:z.string(),originals:z.array(evidenceRow).length(13)});
function sameMetadata(actual,original) {
  return ['mapId','ownerId','inputDescription','createdAt','updatedAt'].every(key=>actual[key]===original[key]);
}
function originalsFrom(rows,review,evidence,target) {
  if (!evidence) return review.sources.map(item=>{
    const row=rows.find(row=>row.mapId===item.mapId);if (!row) fail('missing_selected_map');
    const {data,...original}=row;return original;
  });
  const parsed=evidenceSchema.safeParse(evidence);
  if (!parsed.success || evidence.targetFingerprint!==target || evidence.reviewDigest!==digest(review)) fail('invalid_evidence');
  if (new Set(evidence.originals.map(row=>row.mapId)).size!==13
    || !isDeepStrictEqual(evidence.originals.map(row=>row.mapId),review.sources.map(row=>row.mapId))) fail('invalid_evidence');
  return evidence.originals;
}

// Build only parameterized paths and approved text. Legacy string values come
// from the original PostgreSQL JSONB expression, never JS serialization.
export function patchExpression(base,changes,candidate,values) {
  const parameter=value=>{values.push(value);return '$'+values.length;};
  let expression=base;
  for (const change of changes) {
    const p=parameter(change.path.map(String))+'::text[]';
    if (change.kind==='wrap_legacy_task') expression=`jsonb_set(${expression},${p},jsonb_build_object('description',${base} #> ${p},'relatedFeatures','[]'::jsonb),false)`;
    else if (change.kind==='set_missing_description') {
      let value=candidate;for (const part of change.path) value=value[part];
      expression=`jsonb_set(${expression},${p},to_jsonb(${parameter(value)}::text),true)`;
    } else fail('unknown_patch');
  }
  return expression;
}

async function readInventory(client,config,baseline,work) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");await client.query('SET LOCAL search_path=public,pg_catalog');
    const target=await verifyTarget(client,config);
    if (await inspectSchema(client,baseline)) fail('reconciliation_requires_pre013_schema');
    const rows=(await client.query(`/* reconcile:inventory */ SELECT ${rowFields} FROM public.maps ORDER BY id`)).rows;
    const history=(await client.query(`/* reconcile:history */ SELECT v.map_id AS "mapId",v.version,v.data,
      v.data IS NOT DISTINCT FROM m.data AS matches_current FROM public.map_versions v LEFT JOIN public.maps m ON m.id=v.map_id ORDER BY v.map_id,v.version`)).rows;
    const inventory={target,rows,history};
    return work?await work(inventory):inventory;
  } finally { await client.query('ROLLBACK'); }
}

async function project(client,original,candidate) {
  const values=[original.dataJsonbText],expression=patchExpression('$1::jsonb',candidate.changes,candidate.candidate,values);
  const {rows:[row]}=await client.query(`/* reconcile:project */ SELECT approved AS data,approved::text AS "dataJsonbText" FROM (SELECT ${expression} AS approved) result`,values);
  if (!row || !isDeepStrictEqual(row.data,candidate.candidate) || !MapprSystemSchema.safeParse(row.data).success
    || !verifyUnchangedNonTargets(source(original).data,row.data,candidate.changes)) fail('candidate_invalid');
  return {...original,...row};
}
function classify(row,original,expected,target) {
  if (!row || !sameMetadata(row,original)) fail('stale_owner_or_metadata');
  const fingerprint=sourceFingerprint(source(row),target);
  if (row.matches_original && fingerprint===sourceFingerprint(source(original),target)) return 'original';
  if (row.matches_candidate && fingerprint===sourceFingerprint(source(expected),target)) return 'applied';
  fail('unexpected_third_state');
}
async function compare(client,original,expected,lock=false) {
  const sql=`/* reconcile:compare */ SELECT ${rowFields},data IS NOT DISTINCT FROM $2::jsonb AS matches_original,
    data IS NOT DISTINCT FROM $3::jsonb AS matches_candidate FROM public.maps WHERE id=$1${lock?' FOR UPDATE':''}`;
  return (await client.query(sql,[original.mapId,original.dataJsonbText,expected.dataJsonbText])).rows[0];
}

async function plan(client,inventory,review,evidence) {
  const {rows,history,target}=inventory,originals=originalsFrom(rows,review,evidence,target);
  const originalById=new Map(originals.map(row=>[row.mapId,row]));
  const virtual=rows.map(row=>source(originalById.get(row.mapId)??row));
  const candidates=validateReconciliationReview(virtual,review,target);
  if (candidates.length!==13) fail('unexpected_reconciliation_scope');
  const selected=new Set(originals.map(row=>row.mapId));
  const grouped=new Map();
  for (const snapshot of history) {
    if (selected.has(snapshot.mapId) || !rows.some(row=>row.mapId===snapshot.mapId)) fail('unexpected_history');
    if (!MapprSystemSchema.safeParse(snapshot.data).success) fail('invalid_history');
    const group=grouped.get(snapshot.mapId)??[];group.push(snapshot);grouped.set(snapshot.mapId,group);
  }
  for (const group of grouped.values()) if (group.some((row,index)=>row.version!==index+1) || group.at(-1).matches_current!==true) fail('invalid_history');
  if (rows.filter(row=>!selected.has(row.mapId)).some(row=>!MapprSystemSchema.safeParse(row.data).success)) fail('quarantined_inventory');
  const items=[];
  for (const candidate of candidates) {
    const original=originalById.get(candidate.mapId),expected=await project(client,original,candidate);
    const state=classify(await compare(client,original,expected),original,expected,target);
    items.push({original,expected,candidate,state});
  }
  return {originals,virtual,items};
}

export async function runReconciliation(database,request) {
  const progress={validated:0,applied:0,alreadyApplied:0,remaining:13};
  let client;
  try {
    const {config,review}=assertReconciliationRequest(request.config,request.mode,request.confirmation,request.packet);
    if (request.mode==='execute' && !request.evidenceStore) fail('private_evidence_required');
    const evidence=await request.evidenceStore?.read()??null;
    client=await database.connect();
    let inventory;
    const readPlan=entry=>readInventory(client,config,request.baselineSql,async fresh=>{
      inventory=fresh;return plan(client,fresh,review,entry);
    });
    const prepared=await readPlan(evidence);progress.validated=13;
    const summary=()=>({...progress,maps:inventory.rows.length,tasks:131,descriptions:25,simulatedQuarantine:0});
    if (request.mode==='validate') return {...summary(),original:prepared.items.filter(item=>item.state==='original').length,
      previouslyApplied:prepared.items.filter(item=>item.state==='applied').length,mode:'validate'};
    if (!evidence) await request.evidenceStore.save({formatVersion:1,targetFingerprint:inventory.target,reviewDigest:digest(review),originals:prepared.originals});
    const lease=Object.create(client);lease.query=client.query.bind(client);lease.release=()=>{};
    const pinned={connect:async()=>lease};
    for (const item of prepared.items) {
      const outcome=await revisionTransaction(pinned,async locked=>{
        await verifyTarget(locked,config);
        const row=await compare(locked,item.original,item.expected,true);
        if (await inspectSchema(locked,request.baselineSql)) fail('reconciliation_requires_pre013_schema');
        const state=classify(row,item.original,item.expected,inventory.target);
        const {rows:[history]}=await locked.query('/* reconcile:locked-history */ SELECT count(*)::integer AS count FROM public.map_versions WHERE map_id=$1',[item.original.mapId]);
        if (history.count!==0) fail('unexpected_history');
        validateReconciliationReview(prepared.virtual.map(sourceRow=>sourceRow.mapId===row.mapId
          ? source(state==='original'?row:item.original):sourceRow),review,inventory.target);
        if (state==='applied') return state;
        const values=[],expression=patchExpression('data',item.candidate.changes,item.candidate.candidate,values);
        const id='$'+(values.push(item.original.mapId)),owner='$'+(values.push(item.original.ownerId)),before='$'+(values.push(item.original.dataJsonbText)),after='$'+(values.push(item.expected.dataJsonbText));
        const updated=await locked.query(`/* reconcile:update */ UPDATE public.maps SET data=${expression}
          WHERE id=${id} AND anon_id=${owner} AND data IS NOT DISTINCT FROM ${before}::jsonb
          RETURNING ${rowFields},data IS NOT DISTINCT FROM ${after}::jsonb AS matches_candidate`,values);
        const result=updated.rows[0];
        if (updated.rowCount!==1 || !result || !sameMetadata(result,item.original) || !result.matches_candidate
          || sourceFingerprint(source(result),inventory.target)!==sourceFingerprint(source(item.expected),inventory.target)
          || !MapprSystemSchema.safeParse(result.data).success
          || !verifyUnchangedNonTargets(source(item.original).data,result.data,item.candidate.changes)) fail('write_verification_failed');
        return 'original';
      });
      if (outcome==='applied') progress.alreadyApplied++;else progress.applied++;
      progress.remaining--;
    }
    const after=await readPlan({formatVersion:1,targetFingerprint:inventory.target,reviewDigest:digest(review),originals:prepared.originals});
    if (after.items.some(item=>item.state!=='applied')) fail('reconciliation_incomplete');
    return {...summary(),mode:'execute'};
  } catch (error) {
    const code=error instanceof ReconciliationError || error instanceof CutoverError ? error.code:'reconciliation_failed';
    throw new ExecutorError(code,progress);
  } finally { client?.release(); }
}
