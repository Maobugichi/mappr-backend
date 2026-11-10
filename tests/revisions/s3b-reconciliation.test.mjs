import assert from 'node:assert/strict';
import test from 'node:test';
import { MapprSystemSchema } from '../../src/schema/mapprSystem.ts';
import { normalizeLegacyTasks,buildReconciliationReview,validateReconciliationReview,sourceFingerprint,
  verifyUnchangedNonTargets } from '../../scripts/lib/s3b-reconciliation.mjs';

// Pure fixtures only. No dotenv, database/AI module, filesystem packet, or network.
process.env.DATABASE_URL='must-never-be-used';
const target='a'.repeat(64),owner='11111111-1111-4111-8111-111111111111';
const mapA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',mapB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base={meta:{productName:'Fixture',oneLineSummary:''},product:{summary:'',concepts:[]},users:[],features:[],techStack:[],
  architecture:{nodes:[],edges:[]},dataModel:{entities:[],relations:[]},
  designSystem:{colors:[],typography:[],spacing:[],components:[]},developmentPlan:[]};
const copy=value=>structuredClone(value);
function source(mapId,data){return {mapId,ownerId:owner,data,dataJsonbText:JSON.stringify(data)};}
function fixtures(){
  const a=copy(base);a.developmentPlan=[{phase:1,title:'Phase',items:['  Exact text\r\nsecond line 🧭  ','','task three']}];
  a.privateExtra={retained:['same',1,null]};
  const b=copy(base);b.developmentPlan=[{phase:1,title:'Phase',items:['legacy task']}];
  b.architecture={nodes:[{id:'api',label:'API fixture',type:'service'},{id:'db',label:'Database fixture',type:'database'}],
    edges:[{from:'api',to:'db',label:'stored link'}]};
  return [source(mapA,a),source(mapB,b)];
}
function approve(packet){
  const reviewed=copy(packet);reviewed.taskPolicy.approved=true;
  for(const map of reviewed.architecture)for(const node of map.nodes){
    node.proposedDescription='Human-authored offline fixture description for '+node.type;node.approved=true;
  }
  return reviewed;
}
const rejects=(work,code)=>assert.throws(work,error=>error.code===code);

test('task wrapping preserves exact UTF-8 text/order and every non-target field',()=>{
  const sources=fixtures(),before=copy(sources),result=normalizeLegacyTasks(sources[0].data);
  assert.equal(result.wrappedTasks,3);assert.equal(result.currentSchemaValid,true);assert.equal(result.nonTargetPreserved,true);
  const original=sources[0].data.developmentPlan[0].items,items=result.candidate.developmentPlan[0].items;
  assert.deepEqual(items.map(item=>Buffer.from(item.description,'utf8')),original.map(item=>Buffer.from(item,'utf8')));
  assert.ok(items.every(item=>item.relatedFeatures.length===0));assert.deepEqual(sources,before);
  assert.deepEqual(result.candidate.privateExtra,sources[0].data.privateExtra);
  assert.deepEqual(result.changes.map(change=>change.path),[0,1,2].map(index=>['developmentPlan',0,'items',index]));
  assert.equal(JSON.stringify(result.changes).includes('Exact text'),false);
});

test('normalization is idempotent and object-format tasks retain all their fields',()=>{
  const result=normalizeLegacyTasks(fixtures()[0].data),again=normalizeLegacyTasks(result.candidate);
  assert.deepEqual(again.candidate,result.candidate);assert.deepEqual(again.changes,[]);
  const current=copy(base);current.developmentPlan=[{phase:1,title:'',items:[{description:'Existing',relatedFeatures:['feature-id'],extra:'retain'}]}];
  const unchanged=normalizeLegacyTasks(current);assert.deepEqual(unchanged.candidate,current);assert.equal(unchanged.wrappedTasks,0);
});

test('unexpected task and system shapes are rejected without content in errors',async t=>{
  for(const [name,edit] of [['number',data=>data.developmentPlan[0].items[0]=42],
    ['partial object',data=>data.developmentPlan[0].items[0]={description:'incomplete'}],
    ['missing section',data=>delete data.product],['null node description',data=>data.architecture.nodes[0].description=null]]){
    await t.test(name,()=>{const sources=fixtures();edit(sources[1].data);rejects(()=>normalizeLegacyTasks(sources[1].data),'unrecognized_source_shape');});
  }
});

test('review packet contains only affected references, minimal existing context and blank unapproved proposals',()=>{
  const sources=fixtures(),before=copy(sources),packet=buildReconciliationReview(sources,target);
  assert.equal(packet.sources.length,2);assert.equal(packet.architecture.length,1);assert.equal(packet.architecture[0].nodes.length,2);
  assert.equal(packet.taskPolicy.meaning,'no_relationships_recorded_in_legacy_source');assert.equal(packet.taskPolicy.approved,false);
  for(const node of packet.architecture[0].nodes){assert.equal(node.suggestedDescription,'');assert.equal(node.proposedDescription,'');assert.equal(node.approved,false);assert.equal(node.descriptionOrigin,'new_proposed_content');}
  assert.equal(packet.architecture[0].nodes[0].relationships[0].otherLabel,'Database fixture');
  assert.equal(JSON.stringify(packet).includes(owner),false);assert.equal(JSON.stringify(packet).includes('legacy task'),false);
  assert.deepEqual(sources,before);
});

test('task policy and every description approval are required',()=>{
  const sources=fixtures(),packet=buildReconciliationReview(sources,target);
  rejects(()=>validateReconciliationReview(sources,packet,target),'task_policy_approval_required');
  packet.taskPolicy.approved=true;rejects(()=>validateReconciliationReview(sources,packet,target),'description_approval_required');
  const partial=approve(packet);partial.architecture[0].nodes[1].approved=false;
  rejects(()=>validateReconciliationReview(sources,partial,target),'description_approval_required');
  const incomplete=approve(packet);incomplete.architecture[0].nodes.pop();
  rejects(()=>validateReconciliationReview(sources,incomplete,target),'incomplete_or_unknown_targets');
});

test('duplicate and unknown map/node references fail closed',async t=>{
  const sources=fixtures(),packet=approve(buildReconciliationReview(sources,target));
  for(const [name,edit,code] of [
    ['duplicate map',p=>p.sources.push(copy(p.sources[0])),'duplicate_target'],
    ['duplicate node',p=>p.architecture[0].nodes.push(copy(p.architecture[0].nodes[0])),'duplicate_target'],
    ['unknown map',p=>p.sources[0].mapId='cccccccc-cccc-4ccc-8ccc-cccccccccccc','stale_or_unknown_source'],
    ['unknown node',p=>p.architecture[0].nodes[0].nodeId='unknown','stale_or_unknown_node'],
  ])await t.test(name,()=>{const p=copy(packet);edit(p);rejects(()=>validateReconciliationReview(sources,p,target),code);});
  rejects(()=>buildReconciliationReview([...sources,sources[0]],target),'duplicate_target');
});

test('changed source, owner metadata, raw JSONB text, target and context are refused',async t=>{
  const sources=fixtures(),packet=approve(buildReconciliationReview(sources,target));
  for(const [name,edit] of [['data',s=>{s[0].data.product.summary='changed';s[0].dataJsonbText=JSON.stringify(s[0].data);}],
    ['owner',s=>s[0].ownerId='22222222-2222-4222-8222-222222222222'],
    ['raw source',s=>s[0].dataJsonbText=' '+s[0].dataJsonbText]]){
    await t.test(name,()=>{const changed=copy(sources);edit(changed);rejects(()=>validateReconciliationReview(changed,packet,target),'stale_or_unknown_source');});
  }
  rejects(()=>validateReconciliationReview(sources,packet,'b'.repeat(64)),'target_mismatch');
  const changed=copy(packet);changed.architecture[0].nodes[0].label='changed';
  rejects(()=>validateReconciliationReview(sources,changed,target),'stale_or_unknown_node');
  const bad=copy(sources[0]);bad.dataJsonbText='{}';rejects(()=>sourceFingerprint(bad,target),'source_capture_mismatch');
});

test('blank, ID-only, label-only and schema-invalid approved descriptions are refused',async t=>{
  const sources=fixtures(),packet=approve(buildReconciliationReview(sources,target));
  for(const [name,value,code] of [['blank','  ','invalid_description'],['ID','api','invalid_description'],['label','API fixture','invalid_description'],['nonstring',42,'invalid_review_packet']]){
    await t.test(name,()=>{const p=copy(packet);p.architecture[0].nodes[0].proposedDescription=value;rejects(()=>validateReconciliationReview(sources,p,target),code);});
  }
});

test('fully approved fixture candidates pass the exact current schema with only declared target differences',()=>{
  const sources=fixtures(),before=copy(sources),packet=approve(buildReconciliationReview(sources,target));
  const candidates=validateReconciliationReview(sources,packet,target);
  assert.equal(candidates.length,2);for(const result of candidates){assert.equal(MapprSystemSchema.safeParse(result.candidate).success,true);assert.equal(result.nonTargetPreserved,true);}
  assert.deepEqual(sources,before);
  const result=candidates[1],original=sources[1].data;
  assert.equal(result.changes.filter(change=>change.kind==='set_missing_description').length,2);
  const tampered=copy(result.candidate);tampered.product.summary='unexpected';
  assert.equal(verifyUnchangedNonTargets(original,tampered,result.changes),false);
  const repeated=normalizeLegacyTasks(result.candidate);assert.deepEqual(repeated.candidate,result.candidate);assert.deepEqual(repeated.changes,[]);
});
